import { Hono } from "hono";
import { health } from "./routes/health";
import { line } from "./routes/line";
import { messenger } from "./routes/messenger";
import { booking } from "./routes/booking";
import { publicApi } from "./routes/public";
import { env } from "./lib/env";

const app = new Hono();
app.route("/", health);
app.route("/", line);
app.route("/", messenger);
app.route("/", booking);
app.route("/", publicApi);
app.get("/", (c) => c.text("BAANDEK bot API"));

export default { port: env.port, fetch: app.fetch };
