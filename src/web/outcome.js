// @ts-check
/**
 * Turns a job snapshot into the words the screen shows. Pure functions, no Preact,
 * so node:test checks every case without a browser. app.js only draws the result.
 *
 * The end screen answers, in 5 seconds: finished or failed, why, how to fix it,
 * what is on the iPod now, and whether it is safe to unplug.
 */

/** @typedef {import("../shared/job.ts").JobSnapshot} JobSnapshot */

/**
 * @typedef {object} Outcome
 * @property {"ok" | "warn" | "bad"} tone
 * @property {string} headline
 * @property {string} ipodState
 * @property {string} [fix]
 * @property {string} safeToUnplug
 * @property {string[]} warnings
 */

const SAFE = "Yes, after you eject it in Finder.";

/**
 * The end screen, for a job that is done or failed.
 * @param {JobSnapshot} job
 * @returns {Outcome}
 */
export function describeOutcome(job) {
  // Tracks that failed for good also retried first; they are reported as missing.
  const recovered = job.retried.filter((r) => !job.skipped.some((s) => s.index === r.index));
  const warnings = recovered.length
    ? [`${plural(recovered.length, "track")} needed retries, then copied.`]
    : [];
  if (job.status === "failed") return { ...describeFailure(job), safeToUnplug: SAFE, warnings };

  const erased = job.plan?.ipodTracksNow ? "Old music erased. " : "";
  const missing = job.skipped.length;
  if (missing === 0) {
    return {
      tone: "ok",
      headline: "Sync finished",
      ipodState: `${erased}All ${plural(job.tracksDone, "new track")} on the iPod.`,
      safeToUnplug: SAFE,
      warnings,
    };
  }
  return {
    tone: job.tracksDone === 0 ? "bad" : "warn",
    headline: `Sync finished, ${plural(missing, "track")} missing`,
    ipodState: `${erased}${job.tracksDone} of ${plural(job.tracksTotal, "new track")} on the iPod.`,
    fix: fixForSkipped(job.skipped),
    safeToUnplug: SAFE,
    warnings,
  };
}

/**
 * What the iPod holds after a failure: the job's ipod state, refined by the step.
 * @param {JobSnapshot} job
 * @returns {{ tone: "bad", headline: string, ipodState: string, fix: string }}
 */
function describeFailure(job) {
  const headline = "Sync failed";
  if (job.ipod === "untouched") {
    return {
      tone: "bad",
      headline,
      ipodState: "Unchanged. Nothing was erased.",
      fix:
        job.step === "opening"
          ? `Check that the iPod is mounted at ${job.mountPath}, then try again.`
          : "Check the playlist name and the iPod folder, then try again.",
    };
  }
  if (job.step === "wiping") {
    return {
      tone: "bad",
      headline,
      ipodState: "Unknown. The wipe may have stopped partway, so some old music may be gone.",
      fix: "Run the sync again. It finishes the wipe and copies every track.",
    };
  }
  return {
    tone: "bad",
    headline,
    ipodState:
      "Old music erased. New tracks were copied, but the track list was not saved, so the iPod shows no music.",
    fix: "Run the sync again.",
  };
}

/** @param {JobSnapshot["skipped"]} skipped */
function fixForSkipped(skipped) {
  const unsupported = skipped.filter((s) => /unsupported audio format/i.test(s.reason)).length;
  const other = skipped.length - unsupported;
  const fixes = [];
  if (unsupported) {
    fixes.push(
      `Convert ${plural(unsupported, "track")} to MP3 or AAC in Plex, or remove ${unsupported === 1 ? "it" : "them"} from the playlist.`,
    );
  }
  if (other) {
    fixes.push(
      `Run the sync again to retry ${plural(other, "track")}. It erases and copies every track again.`,
    );
  }
  return fixes.join(" ");
}

/**
 * The one "doing now" line, for a job that is writing to the iPod.
 * @param {JobSnapshot} job
 */
export function describeDoingNow(job) {
  switch (job.step) {
    case "opening":
      return "Opening the iPod";
    case "wiping":
      return "Erasing the iPod and backing up its track list";
    case "downloading": {
      const c = job.current;
      if (!c) return `Downloading: ${job.tracksDone} of ${job.tracksTotal} done`;
      const prefix = `Downloading ${c.index + 1} of ${job.tracksTotal}: ${c.title}`;
      if (!c.totalBytes && c.receivedBytes === 0) return prefix;
      const size = c.totalBytes
        ? `${(c.receivedBytes / 1_000_000).toFixed(1)} of ${mb(c.totalBytes)}`
        : mb(c.receivedBytes);
      return `${prefix} — ${size}`;
    }
    case "writing":
      return "Writing the track list to the iPod";
    default:
      return job.step ?? job.status;
  }
}

/** @param {number} bytes */
export function mb(bytes) {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** @param {number} n @param {string} word */
export function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
