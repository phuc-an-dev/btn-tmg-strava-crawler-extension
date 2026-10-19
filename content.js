(() => {
  if (globalThis.reviveRunner) return;
  const checkpoint = {
    get:async()=>chrome.runtime.sendMessage({type:"REVIVE_STATE_GET"}),
    set:async data=>chrome.runtime.sendMessage({type:"REVIVE_STATE_SET",data}),
  };
  const runner = globalThis.reviveRunner = {running: false, stop: false};
  async function run(message, reply) {
    let replied = false;
    runner.running = true; runner.stop = false;
    let state;
    try {
      const stored = (await checkpoint.get()).sync;
      if (message.resume && !stored) throw new Error("Chưa có dữ liệu để tiếp tục.");
      const athleteId = ReviveCore.detectAthleteId(document);
      if (!athleteId) throw new Error("Không tìm thấy link hồ sơ trong menu tài khoản Strava. Kiểm tra bạn đang đăng nhập và mở trang thảo luận club.");
      if (message.resume && stored.athleteId !== athleteId) throw new Error("Tài khoản Strava khác lần lấy trước. Hãy lấy mới.");
      state = message.resume ? {...stored, running: true, error: null} : {
        entries: [], pages: 0, cursor: Math.floor(Date.now() / 1000) + 1,
        completed: false, config: message.config, athleteId, startedAt: new Date().toISOString(),
      };
      if (state.completed) throw new Error("Đã lấy hết. Chọn Lấy mới để cập nhật.");
      state.tabId = message.tabId; state.running = true;
      await checkpoint.set({sync: state});
      reply({ok: true}); replied = true;
      while (!runner.stop && state.pages < 5000) {
        const response = await chrome.runtime.sendMessage({type: "REVIVE_FETCH", cursor: state.cursor, athleteId});
        if (response.error) throw new Error(response.error);
        const next = ReviveCore.nextCursor(response.data, state.cursor);
        state.entries = ReviveCore.mergeEntries(state.entries, response.data.entries);
        state.pages++;
        state.completed = next === null;
        if (next !== null) state.cursor = next;
        state.updatedAt = new Date().toISOString();
        await checkpoint.set({sync: state});
        try {await chrome.runtime.sendMessage({type:"REVIVE_SEND"});} catch {}
        if (state.completed) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      if (state.pages >= 5000 && !state.completed) state.error = "Đã đạt giới hạn 5.000 trang.";
    } catch (e) {
      if (!replied) {reply({error: String(e.message ?? e)}); replied = true;}
      if (state) state.error = String(e.message ?? e);
      else await checkpoint.set({lastError: String(e.message ?? e)});
    } finally {
      runner.running = false;
      if (state) {state.running = false; await checkpoint.set({sync: state});}
    }
  }
  chrome.runtime.onMessage.addListener((m, _sender, reply) => {
    if (m.type === "REVIVE_PING") {reply({running: runner.running}); return;}
    if (m.type !== "REVIVE_COMMAND") return;
    if (m.action === "stop") {runner.stop = true; reply({ok: true}); return;}
    if (m.action === "start") {
      if (runner.running) {reply({error: "Đang đồng bộ. Hãy dừng trước."}); return;}
      void run(m, reply); return true;
    }
  });
})();
