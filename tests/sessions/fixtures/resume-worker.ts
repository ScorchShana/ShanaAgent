import { resumeSession } from "../../../src/sessions/recovery.js";
import { SessionStore, SessionStoreError } from "../../../src/sessions/session-store.js";

const [sessionsDir, workspaceId, sessionId, workerId] = process.argv.slice(2);
if (!sessionsDir || !workspaceId || !sessionId || !workerId || !process.send)
  throw new Error("Missing worker arguments");
const store = new SessionStore({ sessionsDir });
const ref = { workspaceId, sessionId };
process.on("message", (message) => {
  void (async () => {
    if (message === "resume") {
      try {
        await resumeSession(store, ref);
        await store.appendRecord(ref, { type: "user_prompt", runId: workerId, text: workerId });
        process.send!("acquired");
      } catch (error) {
        if (error instanceof SessionStoreError && error.code === "occupied") process.send!("occupied");
        else throw error;
      }
    } else if (message === "release") {
      await store.releaseSession(ref);
      process.send!("released");
    }
  })().catch((error) => {
    process.stderr.write(String(error));
    process.exitCode = 1;
    process.disconnect();
  });
});
process.send("ready");
