// Small WebSocket-compatible wrapper over the iOS scoped-TLS terminal plugin.
export function createPinnedSocket(url, { plugin, id, states }) {
  const socket = new EventTarget(); socket.readyState = states.CONNECTING;
  let listener; let closed = false;
  const cleanup = () => { listener?.remove(); listener = null; };
  const fail = () => { if (!closed) { closed = true; socket.readyState = states.CLOSED; socket.dispatchEvent(new Event("close")); cleanup(); } };
  socket.send = (data) => { if (socket.readyState !== states.OPEN) throw new Error("Terminal déconnecté."); plugin.send({ id, data: String(data) }).catch(fail); };
  socket.close = () => { if (closed) return; closed = true; socket.readyState = states.CLOSED; plugin.close({ id }).catch(() => {}); cleanup(); };
  (async () => {
    try {
      listener = await plugin.addListener("socketEvent", (event) => {
        if (event.id !== id || closed) return;
        if (event.type === "open") { socket.readyState = states.OPEN; socket.dispatchEvent(new Event("open")); }
        else if (event.type === "message") socket.dispatchEvent(new MessageEvent("message", { data: event.data }));
        else if (event.type === "close") fail();
      });
      if (closed) { cleanup(); return; }
      await plugin.connect({ id, url });
      if (closed) await plugin.close({ id }).catch(() => {});
    } catch { fail(); }
  })();
  return socket;
}
