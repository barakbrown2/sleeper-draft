// src/sim.worker.js - Web Worker wrapper around SimCore.runSim.
importScripts('./simcore.js');

self.onmessage = (e) => {
  const { id, input } = e.data || {};
  try {
    const result = self.SimCore.runSim(input);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message ? err.message : err) });
  }
};
