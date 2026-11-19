// Corre en GitHub Actions cada 15 minutos.
// 1) Lee el plan desde Firestore y genera calendario.ics (suscripción para Apple, Google, Samsung y Notion Calendar).
// 2) Si existe el secreto VAPID_PRIVATE_KEY, manda notificaciones push a los dispositivos suscritos
//    (recordatorios con hora y resumen diario), aunque la página esté cerrada.
import { readFile, writeFile } from "node:fs/promises";

const PROJECT = "cafe-frio-99061";
const API_KEY = "AIzaSyD13FQVS_tKEb6JGGT0dHSe1S1tIrkp5pM";
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const SITE = "https://eliaflores.github.io/Dashboard-Cafe-Frio/";
const VAPID_PUBLIC = "BFmjQF89Yh_mqMJGbP3efu8Dw74fwRG22fAanPdPbqVGoEpGxYyuQ2JA1pnVSQfla8qdUjGPJErdHARzOE1G4EI";
const STATE_FILE = ".github/notify-state.json";
const DEF_TZ = "America/Chihuahua";
const MES = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
const AREAS = { din: "Decisiones y dinero", tra: "Trámites", com: "Equipo e instalación", ope: "Operación", ven: "Ventas y marketing" };

function dec(v) {
  if (!v || typeof v !== "object") return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("timestampValue" in v) return v.timestampValue;
  if ("mapValue" in v) { const o = {}; for (const [k, x] of Object.entries(v.mapValue.fields || {})) o[k] = dec(x); return o; }
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(dec);
  return null;
}
async function getJSON(url, opt) { const r = await fetch(url, opt); if (!r.ok) throw new Error(r.status + " " + url.split("?")[0]); return r.json(); }

// ---------- fechas ----------
const pad = (n) => String(n).padStart(2, "0");
const ymd = (s) => s.replace(/-/g, "");
function addDaysStr(s, n) { const [y, m, d] = s.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; }
function dayDiff(a, b) { const p = (s) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); }; return Math.round((p(a) - p(b)) / 864e5); }
function dlab(s) { const [, m, d] = s.split("-").map(Number); return d + " " + MES[m - 1]; }
function localParts(ms, tz) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms));
  const g = (k) => Number(p.find((x) => x.type === k).value);
  return { y: g("year"), mo: g("month"), d: g("day"), h: g("hour"), mi: g("minute"), s: g("second") };
}
function localDate(ms, tz) { const p = localParts(ms, tz); return `${p.y}-${pad(p.mo)}-${pad(p.d)}`; }
function localMinutes(ms, tz) { const p = localParts(ms, tz); return p.h * 60 + p.mi; }
function zonedToUtc(str, tz) { // "YYYY-MM-DDTHH:MM" en la zona del dispositivo
  const m = String(str || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/); if (!m) return NaN;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const off = (ms) => { const p = localParts(ms, tz); return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - ms; };
  let t = guess - off(guess); t = guess - off(t); return t;
}
function dueLab(str) { const m = String(str).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/); return m ? `${+m[3]} ${MES[+m[2] - 1]} · ${m[4]}:${m[5]}` : ""; }

// ---------- calendario .ics ----------
const esc = (v) => String(v).replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
function fold(line) { const out = []; let cur = ""; for (const ch of line) { if (Buffer.byteLength(cur + ch) > 73) { out.push(cur); cur = " " + ch; } else cur += ch; } out.push(cur); return out.join("\r\n"); }
function buildICS(S) {
  const STAMP = "20260101T000000Z";
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Cafe Frio//Dashboard//ES", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:Café Frío", "X-WR-CALDESC:Actividades del Dashboard Café Frío", "X-WR-TIMEZONE:" + DEF_TZ,
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H"];
  const alarm = (desc, trig) => L.push("BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + esc(desc), "TRIGGER:" + trig, "END:VALARM");
  const follow = S.follow || {}, names = S.areaNames || {};
  for (const f of S.frentes || []) {
    const o = follow[f.id] || {}; if (!/^\d{4}-\d{2}-\d{2}$/.test(f.s || "") || !/^\d{4}-\d{2}-\d{2}$/.test(f.e || "")) continue;
    const done = o.st === 2;
    const timed = /^\d{2}:\d{2}$/.test(f.t || "");
    const fl = (d, hm, plusMin) => { const [y, m, dd] = d.split("-").map(Number), [h, mi] = hm.split(":").map(Number), x = new Date(Date.UTC(y, m - 1, dd, h, mi + (plusMin || 0))); return `${x.getUTCFullYear()}${pad(x.getUTCMonth() + 1)}${pad(x.getUTCDate())}T${pad(x.getUTCHours())}${pad(x.getUTCMinutes())}00`; };
    L.push("BEGIN:VEVENT", `UID:frente-${f.id}@cafefrio`, "DTSTAMP:" + STAMP, ...(timed ? ["DTSTART:" + fl(f.s, f.t), "DTEND:" + fl(f.e, f.t, 60)] : ["DTSTART;VALUE=DATE:" + ymd(f.s), "DTEND;VALUE=DATE:" + ymd(addDaysStr(f.e, 1))]),
      "SUMMARY:" + esc((done ? "✓ " : "") + (f.k ? "◆ " : "") + f.n),
      "DESCRIPTION:" + esc(`Área: ${names[f.a] || AREAS[f.a] || "Operación"}.` + (o.who ? ` Responsable: ${o.who}.` : "") + (done ? " Hecha." : "") + ` Ver: ${SITE}#calendario`),
      "TRANSP:TRANSPARENT");
    if (!done) {
      if (timed) { alarm(f.n, "PT0M"); if (f.k) { alarm("Mañana: " + f.n, "-P1D"); alarm("En 3 días: " + f.n, "-P3D"); } }
      else { alarm(f.n, "PT9H"); if (f.k) { alarm("Mañana: " + f.n, "-PT15H"); alarm("En 3 días: " + f.n, "-P2DT15H"); } }
    }
    L.push("END:VEVENT");
  }
  for (const t of S.todo || []) {
    const m = String(t.due || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/); if (!m || t.done) continue;
    const start = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]), end = new Date(start + 30 * 60000);
    const fl = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00`;
    L.push("BEGIN:VEVENT", `UID:recordatorio-${t.id}@cafefrio`, "DTSTAMP:" + STAMP, "DTSTART:" + fl(new Date(start)), "DTEND:" + fl(end), "SUMMARY:" + esc("Recordatorio: " + t.t));
    alarm(t.t, "PT0M"); L.push("END:VEVENT");
  }
  L.push("END:VCALENDAR");
  return L.map(fold).join("\r\n") + "\r\n";
}

// ---------- tareas y actividades nuevas ----------
function venceText(d, today, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d || "")) return "sin fecha";
  const n = dayDiff(d, today), lab = dlab(d) + (time ? ", " + time : "");
  return n > 1 ? `vence en ${n} días (${lab})` : n === 1 ? `vence mañana (${lab})` : n === 0 ? `vence hoy (${lab})` : `venció hace ${-n} ${-n === 1 ? "día" : "días"} (${lab})`;
}

// ---------- resumen diario (mismo criterio que la página) ----------
function dailyBody(S, today, P) {
  const L = [], follow = S.follow || {};
  const st = (f) => (follow[f.id] || {}).st || 0;
  const late = (f) => st(f) !== 2 && f.e < today;
  if (P.key) for (const f of S.frentes || []) { if (!f.k || st(f) === 2) continue; const n = dayDiff(f.s, today); if (n === 0) L.push("Hoy: " + f.n); else if (n === 1) L.push("Mañana: " + f.n); else if (n === 3) L.push("En 3 días: " + f.n); }
  if (P.fr) {
    const s = (S.frentes || []).filter((f) => f.s === today && !f.k), e = (S.frentes || []).filter((f) => f.e === today && f.s !== f.e && st(f) !== 2);
    if (s.length) L.push("Empieza" + (s.length > 1 ? "n" : "") + ": " + s.map((f) => f.n).join(", "));
    if (e.length) L.push("Termina" + (e.length > 1 ? "n" : "") + ": " + e.map((f) => f.n).join(", "));
  }
  if (P.late) { const lt = (S.frentes || []).filter(late); if (lt.length) L.push(lt.length === 1 ? "Atrasada: " + lt[0].n : lt.length + " actividades atrasadas"); }
  if (P.todo) { const td = (S.todo || []).filter((t) => !t.done && String(t.due || "").slice(0, 10) === today); if (td.length) L.push(td.length === 1 ? "Recordatorio hoy: " + td[0].t : td.length + " recordatorios hoy"); }
  return L.join("\n");
}

async function main() {
  const doc = await getJSON(`${BASE}/plan/main?key=${API_KEY}`);
  const S = dec(doc.fields && doc.fields.state ? doc.fields.state : { mapValue: { fields: {} } }) || {};
  const ics = buildICS(S);
  let old = ""; try { old = await readFile("calendario.ics", "utf8"); } catch {}
  if (old !== ics) { await writeFile("calendario.ics", ics); console.log("calendario.ics actualizado"); } else console.log("calendario.ics sin cambios");

  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!priv) { console.log("Sin VAPID_PRIVATE_KEY: no se mandan notificaciones push."); return; }
  const webpush = (await import("web-push")).default;
  webpush.setVapidDetails(SITE, VAPID_PUBLIC, priv);

  let subs = [];
  try { const r = await getJSON(`${BASE}/subs?key=${API_KEY}&pageSize=300`); subs = (r.documents || []).map((d) => ({ id: d.name.split("/").pop(), ...dec({ mapValue: { fields: d.fields || {} } }) })); }
  catch (e) { console.log("No se pudieron leer las suscripciones:", e.message); return; }
  console.log("Dispositivos suscritos:", subs.length);

  let state = { sent: {} }; try { state = JSON.parse(await readFile(STATE_FILE, "utf8")); state.sent ||= {}; } catch {}
  const now = Date.now(); let sentCount = 0;
  const send = async (sub, payload, key) => {
    if (state.sent[key]) return;
    try { await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload), { TTL: 6 * 3600 }); state.sent[key] = now; sentCount++; }
    catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) { console.log("Suscripción vencida, se borra", sub.id); await fetch(`${BASE}/subs/${sub.id}?key=${API_KEY}`, { method: "DELETE" }).catch(() => {}); }
      else console.log("Error al enviar a", sub.id, e.statusCode || e.message);
    }
  };
  // Detecta tareas (recordatorios) y actividades nuevas desde la última corrida.
  const firstRun = !state.known; state.known ||= { t: {}, f: {} };
  const items = [...(S.todo || []).map((x) => ["t", x]), ...(S.frentes || []).map((x) => ["f", x])], fresh = [];
  for (const [k, it] of items) {
    if (!it || !it.id || state.known[k][it.id]) continue;
    if (firstRun) { state.known[k][it.id] = 1; continue; }
    if (it.at && now - it.at < 120e3) continue; // recién creada: se espera a que tenga nombre y fecha
    fresh.push([k, it]); state.known[k][it.id] = 1;
  }
  for (const k of ["t", "f"]) { const ids = new Set(items.filter(([x]) => x === k).map(([, it]) => it.id)); for (const id of Object.keys(state.known[k])) if (!ids.has(id)) delete state.known[k][id]; }
  console.log("Nuevas:", fresh.length);

  for (const sub of subs) {
    if (!sub.endpoint || !sub.keys) continue;
    const tz = sub.tz || DEF_TZ, P = { todo: true, fr: true, key: true, late: true, ...(sub.prefs || {}) };
    if (P.todo) for (const t of S.todo || []) {
      if (t.done || !t.due) continue; const at = zonedToUtc(t.due, tz);
      if (isFinite(at) && at <= now && now - at < 3 * 3600e3) await send(sub, { title: "Recordatorio · Café Frío", body: `${t.t} (${dueLab(t.due)})`, tag: "todo-" + t.id, url: "./#inicio" }, `todo:${sub.id}:${t.id}:${t.due}`);
    }
    if (P.nuevo !== false) for (const [k, it] of fresh) {
      if (it.by && P.dev && it.by === P.dev) continue; // no avisar a quien la agregó
      if (k === "t" && it.done) continue;
      const td = localDate(now, tz);
      const body = k === "t" ? `Se agregó tarea: ${it.t} · ${venceText(String(it.due || "").slice(0, 10), td, String(it.due || "").slice(11, 16))}` : `Se agregó actividad: ${it.n} · ${venceText(it.e, td)}`;
      await send(sub, { title: k === "t" ? "Nueva tarea · Café Frío" : "Nueva actividad · Café Frío", body, tag: "new-" + it.id, url: k === "t" ? "./#inicio" : "./#calendario" }, `new:${sub.id}:${it.id}`);
    }
    if (P.todo) for (const f of S.frentes || []) { // actividades con hora: aviso a esa hora
      if (!/^\d{2}:\d{2}$/.test(f.t || "") || ((S.follow || {})[f.id] || {}).st === 2) continue;
      const at = zonedToUtc(f.s + "T" + f.t, tz);
      if (isFinite(at) && at <= now && now - at < 3 * 3600e3) await send(sub, { title: "Actividad · Café Frío", body: `${f.n} (${dueLab(f.s + "T" + f.t)})`, tag: "act-" + f.id, url: "./#calendario" }, `act:${sub.id}:${f.id}:${f.s}T${f.t}`);
    }
    const today = localDate(now, tz), [hh, mm] = String(sub.hour || "09:00").split(":").map(Number);
    if (localMinutes(now, tz) >= (hh || 0) * 60 + (mm || 0)) {
      const key = `daily:${sub.id}:${today}`;
      if (!state.sent[key]) { const body = dailyBody(S, today, P); if (body) await send(sub, { title: "Hoy en Café Frío", body, tag: "daily", url: "./#calendario" }, key); else state.sent[key] = now; }
    }
  }
  const lim = now - 40 * 864e5; for (const k of Object.keys(state.sent)) if (state.sent[k] < lim) delete state.sent[k];
  await writeFile(STATE_FILE, JSON.stringify(state, null, 1) + "\n");
  console.log("Notificaciones enviadas:", sentCount);
}
main().catch((e) => { console.error(e); process.exit(1); });
