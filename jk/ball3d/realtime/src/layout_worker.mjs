/** CPU-only layout solving; the renderer and module functions stay on the page. */
import { layoutFor } from "./layout_kit.mjs";

self.onmessage = async ({ data }) => {
  try {
    let lastSent = -Infinity, lastStage = "";
    const onProgress = (progress) => {
      const now = performance.now();
      if (progress.stage === lastStage && now - lastSent < 100) return;
      lastSent = now;
      lastStage = progress.stage;
      self.postMessage({ progress });
    };
    const { layout } = await layoutFor({ ...data, onProgress });
    self.postMessage({ layout });
  } catch (error) {
    self.postMessage({ error: String(error.message || error) });
  }
};
