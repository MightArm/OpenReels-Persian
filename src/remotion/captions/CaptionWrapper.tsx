import type React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { WordTimestamp } from "../../schema/providers";
import { RTL_CAPTION_FONT } from "../lib/fonts";
import type { WordRenderState } from "./caption-utils";
import { computeWordStates, getWordChunk, isRtlParagraph } from "./caption-utils";

export interface CaptionStyleProps {
  wordStates: WordRenderState[];
  chunkEntryProgress: number;
  accentColor: string;
  /**
   * Overrides the style's own font family. CaptionWrapper sets this only for RTL
   * chunks (Farsi/Arabic), so LTR captions keep the font the style declares.
   */
  fontFamilyOverride?: string;
}

export interface SpringConfig {
  damping: number;
  stiffness: number;
  mass: number;
}

interface CaptionWrapperProps {
  words: WordTimestamp[];
  chunkSize: number;
  lingerS: number;
  accentColor: string;
  springConfig: SpringConfig;
  emphasisIndices?: number[];
  StyleComponent: React.FC<CaptionStyleProps>;
}

/**
 * Shared wrapper that owns timing, word state computation, and chunk entrance.
 * Style components are thin renderers that receive computed WordRenderState[].
 *
 *   CaptionWrapper (this file)
 *   +-- useCurrentFrame() / fps -> currentTime
 *   +-- getWordChunk(words, currentTime, chunkSize, lingerS)
 *   +-- computeWordStates(chunk, chunkStart, currentTime, springFn)
 *   +-- chunkEntryProgress: interpolate over 6 frames from chunk start
 *   +-- <StyleComponent wordStates={...} chunkEntryProgress={...} accentColor={...} />
 */
export const CaptionWrapper: React.FC<CaptionWrapperProps> = ({
  words,
  chunkSize,
  lingerS,
  accentColor,
  springConfig,
  emphasisIndices,
  StyleComponent,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const currentTime = frame / fps;

  const { chunk, chunkStart } = getWordChunk(words, currentTime, chunkSize, lingerS);
  if (chunk.length === 0) return null;

  const emphasisSet = emphasisIndices ? new Set(emphasisIndices) : undefined;

  // Spring function: pure frame-math, seek-safe (no useRef).
  // Each word's spring is computed from its start frame.
  const springFn = (globalIndex: number): number => {
    const word = words[globalIndex];
    if (!word) return 1;
    const wordStartFrame = Math.round(word.start * fps);
    const elapsed = frame - wordStartFrame;
    if (elapsed < 0) return 0;
    return spring({ frame: elapsed, fps, config: springConfig });
  };

  const wordStates = computeWordStates(chunk, chunkStart, currentTime, springFn, emphasisSet);

  // Farsi (and other RTL scripts) need an explicit base direction; without it
  // the caption row is laid out left-to-right and the words render in the wrong
  // order. isRtlParagraph is used rather than isRtlText because a Farsi chunk
  // that *begins* with a Latin word ("NASA ...") must still resolve RTL for the
  // whole row. Each word span is a flex item - its own bidi run - so the row
  // direction alone is enough and no per-word marks are needed. English chunks
  // resolve LTR and set nothing, so their output is unchanged.
  const rtl = isRtlParagraph(chunk.map((w) => w.word).join(" "));

  // The style fonts are latin-only, so Farsi chunks would fall back to a system
  // font (tofu boxes in the headless render container). Swap in the
  // Persian-capable face for RTL chunks only; LTR captions get undefined and
  // render exactly as before.
  const fontFamilyOverride = rtl ? RTL_CAPTION_FONT : undefined;

  // Chunk entrance fade: 6-frame interpolate from the first word's start frame.
  const chunkStartFrame = Math.round(chunk[0]!.start * fps);
  const framesSinceChunk = Math.max(0, frame - chunkStartFrame);
  const chunkEntryProgress = interpolate(framesSinceChunk, [0, 6], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-end",
        alignItems: "center",
        paddingBottom: "18%",
      }}
    >
      <div style={{ opacity: chunkEntryProgress, direction: rtl ? "rtl" : undefined }}>
        <StyleComponent
          wordStates={wordStates}
          chunkEntryProgress={chunkEntryProgress}
          accentColor={accentColor}
          fontFamilyOverride={fontFamilyOverride}
        />
      </div>
    </AbsoluteFill>
  );
};
