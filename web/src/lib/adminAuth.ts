import { supabase } from "./supabase";

export type VerifyResult = { ok: boolean; error?: string };

// Checks the entered password against CRUD_ADMIN_PASSWORD server-side
// (verify-admin-password Edge Function) — the dashboard never sees the
// stored value, only ok:true/false.
export async function verifyAdminPassword(password: string): Promise<VerifyResult> {
  const { data, error } = await supabase.functions.invoke<VerifyResult>("verify-admin-password", {
    body: { password },
  });
  if (error || !data) return { ok: false, error: "network_error" };
  return data;
}

export function adminPasswordErrorMessage(code?: string): string {
  if (code === "not_configured") return "ยังไม่ได้ตั้งค่ารหัสผ่าน Admin — กรุณาติดต่อผู้ดูแลระบบ";
  if (code === "not_authenticated") return "เซสชันหมดอายุ — กรุณาเข้าสู่ระบบใหม่";
  if (code === "network_error") return "ตรวจสอบรหัสผ่านไม่สำเร็จ — ลองใหม่อีกครั้ง";
  return "รหัสไม่ถูกต้อง ไม่มีการบันทึกข้อมูล";
}
