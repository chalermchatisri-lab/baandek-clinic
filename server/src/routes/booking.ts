import { Hono } from "hono";
import { admin } from "../lib/supabase";
import { env } from "../lib/env";

export const booking = new Hono();

// ---- Slot definitions (Sat 5 slots, Sun 3 slots — matches the old system) ----
const SLOT_TIMES: Record<number, string[]> = {
  6: ["09:15", "10:00", "11:00", "13:00", "14:00"], // Saturday
  0: ["09:15", "10:00", "11:00"], // Sunday
};
const BOOKABLE_DAYS_AHEAD = 60;

function toYMD(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ---- GET /liff/book — serves the booking form (LIFF page) ----
booking.get("/liff/book", (c) => {
  const liffId = env.liffId;
  return c.html(`<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>จองคิว - บ้านเด็กคลินิก</title>
<script charset="utf-8" src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background:#f0faf7; margin:0; padding:16px; color:#134e4a; }
  h1 { font-size:18px; color:#0f766e; }
  .card { background:#fff; border-radius:12px; padding:16px; margin-bottom:12px; box-shadow:0 1px 3px rgba(0,0,0,.08); }
  label { display:block; font-size:14px; margin:10px 0 4px; font-weight:600; }
  input, select { width:100%; padding:10px; border:1px solid #ccc; border-radius:8px; font-size:16px; box-sizing:border-box; }
  .dates { display:flex; gap:8px; overflow-x:auto; padding:4px 0; }
  .date-btn, .time-btn { padding:10px 14px; border-radius:8px; border:1px solid #14b8a6; background:#fff; color:#0f766e; white-space:nowrap; cursor:pointer; }
  .date-btn.active, .time-btn.active { background:#14b8a6; color:#fff; }
  .times { display:flex; flex-wrap:wrap; gap:8px; margin-top:8px; }
  button.submit { width:100%; padding:14px; background:#0f766e; color:#fff; border:none; border-radius:10px; font-size:16px; margin-top:16px; }
  button.submit:disabled { background:#9ca3af; }
  #status { margin-top:12px; font-size:14px; }
</style>
</head>
<body>
  <h1>🦕 จองคิว บ้านเด็กคลินิก</h1>
  <div class="card">
    <label>เลือกวันที่</label>
    <div class="dates" id="dates">กำลังโหลด...</div>
    <label>เลือกเวลา</label>
    <div class="times" id="times"></div>
  </div>
  <div class="card">
    <label>ชื่อเด็ก</label>
    <input id="childName" placeholder="ชื่อ-นามสกุล หรือชื่อเล่น" />
    <label>เหตุผล</label>
    <select id="reason">
      <option value="รับวัคซีน">รับวัคซีน</option>
      <option value="ไม่สบาย">ไม่สบาย</option>
    </select>
    <button class="submit" id="submitBtn" disabled>ยืนยันการจอง</button>
    <div id="status"></div>
  </div>

<script>
const LIFF_ID = ${JSON.stringify(liffId)};
let slotsData = [];
let selectedDate = null;
let selectedTime = null;

function renderDates() {
  const el = document.getElementById('dates');
  if (slotsData.length === 0) { el.textContent = 'ไม่มีวันว่างในช่วงนี้ค่ะ'; return; }
  el.innerHTML = '';
  slotsData.forEach(d => {
    const btn = document.createElement('button');
    btn.className = 'date-btn';
    btn.textContent = d.date;
    btn.onclick = () => { selectedDate = d.date; selectedTime = null; renderDates(); renderTimes(); updateSubmit(); };
    if (d.date === selectedDate) btn.classList.add('active');
    el.appendChild(btn);
  });
}

function renderTimes() {
  const el = document.getElementById('times');
  el.innerHTML = '';
  const day = slotsData.find(d => d.date === selectedDate);
  if (!day) return;
  day.times.forEach(t => {
    const btn = document.createElement('button');
    btn.className = 'time-btn';
    btn.textContent = t;
    btn.onclick = () => { selectedTime = t; renderTimes(); updateSubmit(); };
    if (t === selectedTime) btn.classList.add('active');
    el.appendChild(btn);
  });
}

function updateSubmit() {
  const name = document.getElementById('childName').value.trim();
  document.getElementById('submitBtn').disabled = !(selectedDate && selectedTime && name);
}
document.getElementById('childName').addEventListener('input', updateSubmit);

async function loadSlots() {
  const res = await fetch('/liff/api/slots');
  const data = await res.json();
  slotsData = data.dates || [];
  renderDates();
}

async function submitBooking() {
  const btn = document.getElementById('submitBtn');
  const statusEl = document.getElementById('status');
  btn.disabled = true;
  statusEl.textContent = 'กำลังจอง...';
  try {
    const profile = await liff.getProfile();
    const res = await fetch('/liff/api/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lineUserId: profile.userId,
        childName: document.getElementById('childName').value.trim(),
        date: selectedDate,
        time: selectedTime,
        reason: document.getElementById('reason').value,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      statusEl.textContent = data.message || 'จองไม่สำเร็จ กรุณาลองใหม่ค่ะ';
      btn.disabled = false;
      if (data.error === 'slot_taken') loadSlots();
      return;
    }
    statusEl.textContent = 'จองสำเร็จ! กำลังส่งข้อความยืนยัน...';
    if (liff.isInClient()) {
      await liff.sendMessages([{ type: 'text', text: data.confirmationText }]);
    }
    setTimeout(() => liff.closeWindow(), 1200);
  } catch (e) {
    statusEl.textContent = 'เกิดข้อผิดพลาด กรุณาลองใหม่ค่ะ';
    btn.disabled = false;
  }
}
document.getElementById('submitBtn').addEventListener('click', submitBooking);

liff.init({ liffId: LIFF_ID }).then(() => {
  if (!liff.isLoggedIn()) { liff.login(); return; }
  loadSlots();
}).catch(err => {
  document.getElementById('status').textContent = 'เปิดหน้านี้ผ่านแอป LINE ค่ะ';
});
</script>
</body>
</html>`);
});

// ---- GET /liff/api/slots ----
booking.get("/liff/api/slots", async (c) => {
  const today = new Date();
  const rangeEnd = new Date(today);
  rangeEnd.setDate(rangeEnd.getDate() + BOOKABLE_DAYS_AHEAD);

  const { data: closures, error: closuresErr } = await admin
    .from("closures")
    .select("start_date, end_date, closure_type")
    .eq("active", true)
    .eq("closure_type", "CLOSE_ALL")
    .lte("start_date", toYMD(rangeEnd))
    .gte("end_date", toYMD(today));
  if (closuresErr) return c.json({ error: closuresErr.message }, 500);

  const closedDates = new Set<string>();
  for (const cl of closures ?? []) {
    const d = new Date(cl.start_date);
    const end = new Date(cl.end_date);
    while (d <= end) {
      closedDates.add(toYMD(d));
      d.setDate(d.getDate() + 1);
    }
  }

  const { data: existing, error: bookedErr } = await admin
    .from("bookings")
    .select("booking_date, booking_time")
    .eq("status", "confirmed")
    .gte("booking_date", toYMD(today))
    .lte("booking_date", toYMD(rangeEnd));
  if (bookedErr) return c.json({ error: bookedErr.message }, 500);

  const bookedSet = new Set((existing ?? []).map((b) => `${b.booking_date}|${b.booking_time}`));

  const now = new Date();
  const result: { date: string; times: string[] }[] = [];
  for (let d = new Date(today); d <= rangeEnd; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    const times = SLOT_TIMES[dow];
    if (!times) continue;

    const ymd = toYMD(d);
    if (closedDates.has(ymd)) continue;

    const isToday = ymd === toYMD(now);
    const available = times.filter((t) => {
      if (bookedSet.has(`${ymd}|${t}`)) return false;
      if (isToday) {
        const parts = t.split(":").map(Number);
        const h = parts[0] ?? 0;
        const m = parts[1] ?? 0;
        const slotTime = new Date(now);
        slotTime.setHours(h, m, 0, 0);
        if (slotTime <= now) return false;
      }
      return true;
    });

    if (available.length > 0) result.push({ date: ymd, times: available });
  }

  return c.json({ dates: result });
});

// ---- POST /liff/api/book ----
booking.post("/liff/api/book", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "invalid_json" }, 400);

  const { lineUserId, childName, date, time, reason } = body as {
    lineUserId?: string;
    childName?: string;
    date?: string;
    time?: string;
    reason?: string;
  };

  if (!lineUserId || typeof lineUserId !== "string") {
    return c.json({ error: "missing_line_user_id" }, 400);
  }
  if (!childName || typeof childName !== "string" || childName.trim().length === 0) {
    return c.json({ error: "missing_child_name" }, 400);
  }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: "invalid_date" }, 400);
  }
  if (!time || !/^\d{2}:\d{2}$/.test(time)) {
    return c.json({ error: "invalid_time" }, 400);
  }
  if (reason !== "รับวัคซีน" && reason !== "ไม่สบาย") {
    return c.json({ error: "invalid_reason" }, 400);
  }

  const bookingDate = new Date(date);
  const dow = bookingDate.getDay() as number;
  const validTimes: string[] | undefined = SLOT_TIMES[dow];
  if (!validTimes || !validTimes.includes(time)) {
    return c.json({ error: "slot_not_offered_that_day" }, 400);
  }

  const { data: closures, error: closuresErr } = await admin
    .from("closures")
    .select("start_date, end_date")
    .eq("active", true)
    .eq("closure_type", "CLOSE_ALL")
    .lte("start_date", date)
    .gte("end_date", date);
  if (closuresErr) return c.json({ error: closuresErr.message }, 500);
  if ((closures ?? []).length > 0) {
    return c.json({ error: "date_closed", message: "วันที่เลือกเป็นวันหยุดของคลินิกค่ะ" }, 400);
  }

  const { data: inserted, error: insertErr } = await admin
    .from("bookings")
    .insert({
      line_user_id: lineUserId,
      child_name: childName.trim(),
      booking_date: date,
      booking_time: time,
      reason,
      status: "confirmed",
    })
    .select()
    .single();

  if (insertErr) {
    if ((insertErr as any).code === "23505") {
      return c.json(
        { error: "slot_taken", message: "ขออภัยค่ะ ช่วงเวลานี้เพิ่งถูกจองไปแล้ว กรุณาเลือกเวลาอื่น" },
        409
      );
    }
    return c.json({ error: insertErr.message }, 500);
  }

  return c.json({
    ok: true,
    booking: inserted,
    confirmationText:
      `✅ จองคิวสำเร็จ\n` +
      `เด็ก: ${inserted.child_name}\n` +
      `วันที่: ${inserted.booking_date}  เวลา: ${inserted.booking_time}\n` +
      `เหตุผล: ${inserted.reason}\n\n` +
      `กรุณามาถึงคลินิกก่อนนัดหมาย 15 นาที กรณีมาเกินเวลานัดหมาย ถือว่าสละสิทธิ์คิวนั้นค่ะ\n` +
      `กรุณาแคปหน้าจอนี้ไว้เป็นหลักฐานค่ะ`,
  });
});
