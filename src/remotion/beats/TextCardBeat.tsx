import type React from "react";
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { isRtlText } from "../captions/caption-utils";
import { RTL_CAPTION_FONT, TEXT_CARD_FONTS } from "../lib/fonts";
import type { SceneProps } from "../lib/score-to-props";

export const TextCardBeat: React.FC<SceneProps> = ({
  scriptLine,
  colorPalette,
  textCardFont,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const scaleIn = spring({ frame, fps, config: { damping: 15, stiffness: 100 } });

  const bg = colorPalette?.background ?? "#1a1a2e";
  const accent = colorPalette?.accent ?? "#e94560";
  const text = colorPalette?.text ?? "#ffffff";

  // Persian/Arabic text cards need an RTL base direction and a font that
  // actually contains the glyphs (TEXT_CARD_FONTS are latin-only, so Persian
  // would fall back to a system font / tofu in the headless renderer).
  // English text resolves LTR via the same bidi rule the captions use, so its
  // font family, direction, and layout are completely unchanged.
  const rtl = isRtlText(scriptLine);

  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(135deg, ${bg} 0%, ${accent}22 100%)`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "80px",
      }}
    >
      <div
        style={{
          transform: `scale(${scaleIn})`,
          textAlign: "center",
          color: text,
          fontSize: 72,
          fontWeight: 900,
          direction: rtl ? "rtl" : undefined,
          fontFamily: rtl
            ? RTL_CAPTION_FONT
            : (textCardFont && TEXT_CARD_FONTS[textCardFont]) ?? "Inter, sans-serif",
          lineHeight: 1.2,
          textShadow: `0 0 40px ${accent}66`,
        }}
      >
        {scriptLine}
      </div>
      {/* Accent bar — above caption safe zone (bottom 18%) */}
      <div
        style={{
          position: "absolute",
          bottom: "35%",
          left: "25%",
          right: "25%",
          height: 6,
          backgroundColor: accent,
          borderRadius: 3,
          transform: `scaleX(${scaleIn})`,
        }}
      />
    </AbsoluteFill>
  );
};
