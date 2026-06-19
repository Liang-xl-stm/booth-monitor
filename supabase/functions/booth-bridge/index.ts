// ============================================================
//  展台监测 — oneNET ↔ Supabase 桥接 Edge Function
//  从 profiles 表读取用户配置，支持多用户自助绑定
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ONEAPI_BASE = "https://iot-api.heclouds.com";
const API_VERSION = "2022-05-01";
const API_METHOD = "sha256";

function addCors(resp: Response, req: Request): Response {
  const origin = req.headers.get("Origin") || "*";
  resp.headers.set("Access-Control-Allow-Origin", origin);
  resp.headers.set("Access-Control-Allow-Credentials", "true");
  resp.headers.set("Access-Control-Allow-Headers", "authorization, x-client-info, apikey, content-type");
  return resp;
}

const defaultHeaders = { "Content-Type": "application/json" };

// ============================================================
// Token 生成
// ============================================================

async function makeToken(accessKey: string, productId: string): Promise<string> {
  const et = Math.floor(Date.now() / 1000) + 3600;
  const res = `products/${productId}`;
  const signStr = `${et}\n${API_METHOD}\n${res}\n${API_VERSION}`;

  const keyBytes = base64ToBytes(accessKey);

  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(signStr));
  const sigBytes = new Uint8Array(sigBuf);
  const sigB64 = btoa(String.fromCharCode(...sigBytes));

  return `et=${et}&method=${API_METHOD}&res=${encodeURIComponent(res)}&version=${API_VERSION}&sign=${encodeURIComponent(sigB64)}`;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ============================================================
// oneNET 请求
// ============================================================

async function oneGet(path: string, accessKey: string, productId: string) {
  const token = await makeToken(accessKey, productId);
  const resp = await fetch(`${ONEAPI_BASE}${path}`, { headers: { Authorization: token } });
  const text = await resp.text();
  try { return JSON.parse(text); } catch { return { code: -1, msg: text }; }
}

async function onePost(path: string, accessKey: string, productId: string, body: Record<string, unknown>) {
  const token = await makeToken(accessKey, productId);
  const resp = await fetch(`${ONEAPI_BASE}${path}`, {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  try { return JSON.parse(text); } catch { return { code: -1, msg: text }; }
}

// ============================================================
// 主入口
// ============================================================

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return addCors(new Response("ok"), req);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body = await req.json();
    const { action } = body;

    let result: Response;
    if (action === "poll") {
      result = await handlePoll(supabase);
    } else if (action === "command") {
      result = await handleCommand(supabase, body);
    } else {
      result = json(400, { error: "未知 action" });
    }
    return addCors(result, req);
  } catch (e: any) {
    return addCors(json(500, { error: e.message }), req);
  }
});

// ============================================================
// poll: 遍历所有 profiles，拉取 oneNET 数据
// ============================================================

async function handlePoll(supabase: ReturnType<typeof createClient>) {
  const results: string[] = [];

  // 读取所有已配置的 profiles
  const { data: profiles } = await supabase.from("profiles").select("*");
  if (!profiles || profiles.length === 0) {
    return json(200, { success: true, results: ["无已配置的用户"] });
  }

  // 获取所有关联设备
  const { data: devices } = await supabase.from("devices").select("*");

  const defaultAccessKey = Deno.env.get("ONENET_ACCESS_KEY")!;
  const defaultProductId = Deno.env.get("ONENET_PRODUCT_ID")!;

  for (const device of (devices || [])) {
    // 找对应用户配置，没有则用环境变量默认值
    const profile = profiles?.find((p: any) =>
      p.device_name === device.device_name && p.product_id === device.product_id
    );
    const accessKey = profile?.access_key || defaultAccessKey;
    const productId = profile?.product_id || device.product_id || defaultProductId;
    if (!accessKey) continue;

    try {
      const path = `/thingmodel/query-device-property?product_id=${encodeURIComponent(productId)}&device_name=${encodeURIComponent(device.device_name)}`;
      const resp = await oneGet(path, accessKey, productId);

      if (resp.code !== 0) continue;

      // oneNET 返回数组: [{identifier, value, time}, ...], value 都是字符串
      const items: any[] = resp.data || [];
      const g = (k: string) => {
        const item = items.find((i: any) => i.identifier === k);
        if (!item || item.value === undefined) return undefined;
        const v = item.value;
        // 转换类型: "true"/"false" → boolean, 数字字符串 → number
        if (v === "true") return true;
        if (v === "false") return false;
        const n = Number(v);
        return isNaN(n) ? v : n;
      };
      const getTime = (k: string) => {
        const item = items.find((i: any) => i.identifier === k);
        return item?.time;
      };

      const temp = g("temperature");
      const hum = g("humidity");
      const light = g("ambient_light");
      const alarm = g("alarm_status");
      const beep = g("beep_enabled");
      const armed = g("sensor_armed");

      if (temp != null || hum != null || light != null) {
        const rawTime = getTime("temperature") || getTime("humidity") || getTime("ambient_light");
        const reportedAt = rawTime ? new Date(rawTime).toISOString() : new Date().toISOString();

        // ---- 报警判断 ----
        let alarmCode = 0;
        if (typeof temp === "number" && temp > 35) alarmCode = 1;
        else if (typeof hum === "number" && hum > 80) alarmCode = 2;
        else if (typeof light === "number" && light < 100) alarmCode = 3;

        const isAlarming = alarmCode !== 0;

        // 查上次报警状态
        const { data: lastAlarm } = await supabase.from("alarm_events")
          .select("alarm_code").eq("device_id", device.id)
          .order("created_at", { ascending: false }).limit(1).maybeSingle();
        const lastCode = lastAlarm?.alarm_code ?? 0;
        const wasAlarming = lastCode !== 0;

        // 状态变化时插入报警事件
        if (isAlarming !== wasAlarming || (isAlarming && alarmCode !== lastCode)) {
          await supabase.from("alarm_events").insert({
            device_id: device.id, alarm_code: alarmCode,
          });
          results.push(`${device.device_name}: 报警 code=${alarmCode}`);
        }

        // 写入遥测（带上正确的 alarm_status）
        await supabase.from("telemetry").insert({
          device_id: device.id,
          temperature: temp, humidity: hum, ambient_light: light,
          alarm_status: isAlarming,
          reported_at: reportedAt,
        });

        // 只保留最新 60 条，删除旧数据
        const { data: allIds } = await supabase.from("telemetry")
          .select("id").eq("device_id", device.id)
          .order("reported_at", { ascending: false });
        if (allIds && allIds.length > 60) {
          const idsToDelete = allIds.slice(60).map((r: any) => r.id);
          await supabase.from("telemetry").delete().in("id", idsToDelete);
        }

        results.push(`${device.device_name}: OK`);
      }

      // beep_enabled / sensor_armed 由用户按钮控制，不从 oneNET 覆盖
    } catch (e: any) {
      results.push(`${device.device_name}: ${e.message}`);
    }
  }

  // 检查所有 pending 指令
  const { data: commands } = await supabase
    .from("device_commands")
    .select("id, device_id, command")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(10);

  if (commands) {
    const svcMap: Record<string, string> = { arm: "arm_sensor", disarm: "disarm_sensor", toggle_beep: "toggle_beep" };

    for (const cmd of commands) {
      const { data: dev } = await supabase.from("devices").select("*").eq("id", cmd.device_id).maybeSingle();
      if (!dev) { await supabase.from("device_commands").update({ status: "failed" }).eq("id", cmd.id); continue; }

      const profile = profiles?.find((p: any) =>
        p.product_id === dev.product_id && p.device_name === dev.device_name
      );
      const cmdAccessKey = profile?.access_key || defaultAccessKey;
      const cmdProductId = profile?.product_id || dev.product_id || defaultProductId;
      if (!cmdAccessKey) continue;

      const svc = svcMap[cmd.command];
      if (!svc) continue;

      const resp = await onePost("/thingmodel/call-service", cmdAccessKey, cmdProductId, {
        product_id: dev.product_id,
        device_name: dev.device_name,
        identifier: svc,
        params: {},
      });

      const newStatus = resp.code === 0 ? "sent" : "failed";
      await supabase.from("device_commands").update({ status: newStatus }).eq("id", cmd.id);

      results.push(`CMD ${dev.device_name}: ${cmd.command} → ${newStatus}`);
    }
  }

  return json(200, { success: true, results });
}

// ============================================================
// command: 前端直接发送指令
// ============================================================

async function handleCommand(
  supabase: ReturnType<typeof createClient>,
  body: { device_id: string; command: string; cmd_id?: number },
) {
  const { data: dev } = await supabase.from("devices").select("*").eq("id", body.device_id).maybeSingle();
  if (!dev) return json(404, { error: "设备不存在" });

  const { data: profile } = await supabase.from("profiles").select("*")
    .eq("product_id", dev.product_id).eq("device_name", dev.device_name).maybeSingle();

  const defAccessKey = Deno.env.get("ONENET_ACCESS_KEY")!;
  const defProductId = Deno.env.get("ONENET_PRODUCT_ID")!;
  const cmdKey = profile?.access_key || defAccessKey;
  const cmdPid = profile?.product_id || dev.product_id || defProductId;

  const svcMap: Record<string, string> = { arm: "arm_sensor", disarm: "disarm_sensor", toggle_beep: "toggle_beep" };
  const svc = svcMap[body.command];
  if (!svc) return json(400, { error: "未知指令" });

  const resp = await onePost("/thingmodel/call-service", cmdKey, cmdPid, {
    product_id: dev.product_id,
    device_name: dev.device_name,
    identifier: svc,
    params: {},
  });

  if (body.cmd_id) {
    await supabase.from("device_commands").update({
      status: resp.code === 0 ? "sent" : "failed"
    }).eq("id", body.cmd_id);
  }

  const ok = resp.code === 0;
  return json(200, {
    success: ok, code: resp.code, msg: resp.msg,
  });
}

function json(status: number, body: Record<string, unknown>, req?: Request) {
  const resp = new Response(JSON.stringify(body), { status, headers: defaultHeaders });
  return req ? addCors(resp, req) : resp;
}
