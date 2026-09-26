import type React from "react";
import { AbsoluteFill, Loop, OffthreadVideo, useVideoConfig } from "remotion";
import type { SceneProps } from "../lib/score-to-props";

export const StockVideoBeat: React.FC<SceneProps> = ({ assetSrc, sourceDurationInSeconds, visualType }) => {
  const { fps, durationInFrames } = useVideoConfig();
  const sceneDurationSeconds = durationInFrames / fps;

  // Looping logic:
  // - If source duration is unknown (null), don't loop (safer fallback)
  // - If source is shorter than scene AND not ai_video, loop it
  // - Exception: AI-generated video clips create visible seams when looped
  // - Otherwise, play once (Remotion's OffthreadVideo handles trimming)
  const needsLoop =
    sourceDurationInSeconds != null &&
    sourceDurationInSeconds < sceneDurationSeconds &&
    visualType !== "ai_video";
  const loopDurationInFrames =
    sourceDurationInSeconds != null ? Math.floor(sourceDurationInSeconds * fps) : durationInFrames;

  const video = assetSrc ? (
    <OffthreadVideo
      src={assetSrc}
      style={{
        width: "100%",
        height: "100%",
        objectFit: "cover",
      }}
      muted
    />
  ) : null;

  return (
    <AbsoluteFill>
      {video && (needsLoop ? <Loop durationInFrames={loopDurationInFrames}>{video}</Loop> : video)}
    </AbsoluteFill>
  );
};
