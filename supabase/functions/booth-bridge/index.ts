// ============================================================
//  展台监测 — oneNET ↔ Supabase 桥接 Edge Function
//  从 profiles 表读取用户配置，支持多用户自助绑定
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ONEAPI_BASE = "https://iot-api.heclouds.com";
const API_VERSION = "2022-05-01";
const API_METHOD = "sha256";

const corsHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ============================================================
// Token 生成
// ============================================================

async function makeToken(accessKey: string, onenetUserId: string): Promise<string> {
  const et = Math.floor(Date.now() / 1000) + 3600;
  const res = `userid/${onenetUserId}`;
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

async function oneGet(path: string, accessKey: string, onenetUserId: string) {
  const token = await makeToken(accessKey, onenetUserId);
  const resp = await fetch(`${ONEAPI_BASE}${path}`, { headers: { Authorization: token } });
  const text = await resp.text();
  try { return JSON.parse(text); } catch { return { code: -1, msg: text }; }
}

async function onePost(path: string, accessKey: string, onenetUserId: string, body: Record<string, unknown>) {
  const token = await makeToken(accessKey, onenetUserId);
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
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { action } = await req.json();

    if (action === "poll") {
      return handlePoll(supabase);
    }
    if (action === "command") {
      const body = await req.json();
      return handleCommand(supabase, body);
    }

    return json(400, { error: "未知 action" });
  } catch (e: any) {
    return json(500, { error: e.message });
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

  for (const profile of profiles) {
    if (!profile.access_key) continue;

    // 找到该用户对应的设备
    const device = devices?.find((d: any) =>
      d.product_id === profile.product_id && d.device_name === profile.device_name
    );
    if (!device) continue;

    try {
      const path = `/thingmodel/query-device-property?product_id=${encodeURIComponent(profile.product_id)}&device_name=${encodeURIComponent(profile.device_name)}`;
      const resp = await oneGet(path, profile.access_key, profile.onenet_user_id);

      if (resp.code !== 0) continue;

      const props = resp.data || {};
      const g = (k: string) => {
        const e = props[k];
        return e && typeof e === "object" && "value" in e ? e.value : undefined;
      };

      const temp = g("temperature");
      const hum = g("humidity");
      const light = g("ambient_light");
      const alarm = g("alarm_status");
      const beep = g("beep_enabled");
      const armed = g("sensor_armed");

      if (temp != null || hum != null || light != null) {
        let reportedAt = new Date().toISOString();
        for (const k of Object.keys(props)) {
          if (props[k]?.time) { reportedAt = new Date(props[k].time).toISOString(); break; }
        }
        await supabase.from("telemetry").insert({
          device_id: device.id,
          temperature: temp,
          humidity: hum,
          ambient_light: light,
          alarm_status: typeof alarm === "boolean" ? alarm : false,
          reported_at: reportedAt,
        });
        results.push(`${profile.username}: OK`);
      }

      if (typeof beep === "boolean" || typeof armed === "boolean") {
        const upd: Record<string, unknown> = { updated_at: new Date().toISOString() };
        if (typeof beep === "boolean") upd.beep_enabled = beep;
        if (typeof armed === "boolean") upd.sensor_armed = armed;
        await supabase.from("device_state").upsert(
          { device_id: device.id, ...upd }, { onConflict: "device_id" }
        );
      }
    } catch (e: any) {
      results.push(`${profile.username}: ${e.message}`);
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

      const profile = profiles.find((p: any) =>
        p.product_id === dev.product_id && p.device_name === dev.device_name
      );
      if (!profile || !profile.access_key) continue;

      const svc = svcMap[cmd.command];
      if (!svc) continue;

      const resp = await onePost("/thingmodel/call-service", profile.access_key, profile.onenet_user_id, {
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
  if (!profile || !profile.access_key) return json(400, { error: "未配置 oneNET" });

  const svcMap: Record<string, string> = { arm: "arm_sensor", disarm: "disarm_sensor", toggle_beep: "toggle_beep" };
  const svc = svcMap[body.command];
  if (!svc) return json(400, { error: "未知指令" });

  const resp = await onePost("/thingmodel/call-service", profile.access_key, profile.onenet_user_id, {
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

  return json(resp.code === 0 ? 200 : 500, {
    success: resp.code === 0, code: resp.code, msg: resp.msg,
  });
}

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}
