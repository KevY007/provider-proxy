import type { Operation } from "../types";
import { DriverClientError, type Driver } from "./driver-types";
import { falImagesDriver } from "./fal";
import { falVideoCreateDriver } from "./fal-video";
import { replicateImagesDriver } from "./replicate";

/** Presets served by a driver instead of the generic "one OpenAI-shaped HTTP call" path. */
const DRIVER_PRESETS = new Set(["fal", "replicate"]);

const unsupported = (preset: string): Driver => ({
  name: `${preset}.unsupported`,
  async run() {
    throw new DriverClientError(400, "This model does not support this endpoint.", "unsupported_endpoint", "model");
  },
});

/** The driver that serves `op` on a provider with this preset, or null for ordinary (generic HTTP) providers. */
export function getDriver(preset: string, op: Operation): Driver | null {
  if (!DRIVER_PRESETS.has(preset)) return null;
  if (op === "images_generations") return preset === "fal" ? falImagesDriver : replicateImagesDriver;
  if (preset === "fal" && op === "videos_create") return falVideoCreateDriver;
  // fal video results are plain CDN files: the generic streaming path serves them (ExecOptions.externalUrl)
  if (preset === "fal" && op === "videos_content") return null;
  return unsupported(preset);
}
