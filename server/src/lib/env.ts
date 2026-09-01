function req(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env: ${k}`);
  return v;
}
export const env = {
  supabaseUrl: req("SUPABASE_URL"),
  supabaseServiceKey: req("SUPABASE_SERVICE_ROLE_KEY"),
  lineToken: process.env.LINE_CHANNEL_ACCESS_TOKEN ?? "",
  lineSecret: process.env.LINE_CHANNEL_SECRET ?? "",
  liffId: process.env.LIFF_ID ?? "",
  fbPageToken: process.env.FB_PAGE_ACCESS_TOKEN ?? "",
  fbVerifyToken: process.env.FB_VERIFY_TOKEN ?? "",
  geminiKey: process.env.GEMINI_API_KEY ?? "",
  geminiModel: process.env.GEMINI_MODEL ?? "gemini-2.0-flash",
  internalCronSecret: process.env.INTERNAL_CRON_SECRET ?? "",
  debugToken: process.env.DEBUG_TOKEN ?? "",
  port: Number(process.env.PORT ?? 8080),
};
