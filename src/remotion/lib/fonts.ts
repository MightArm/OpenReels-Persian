import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadMerriweather } from "@remotion/google-fonts/Merriweather";
import { loadFont as loadMontserrat } from "@remotion/google-fonts/Montserrat";
import { loadFont as loadOswald } from "@remotion/google-fonts/Oswald";
import { loadFont as loadPlayfairDisplay } from "@remotion/google-fonts/PlayfairDisplay";
import { loadFont as loadSpaceGrotesk } from "@remotion/google-fonts/SpaceGrotesk";
import { loadFont as loadVazirmatn } from "@remotion/google-fonts/Vazirmatn";

const { fontFamily: montserrat } = loadMontserrat("normal", {
  weights: ["700", "900"],
  subsets: ["latin"],
});

const { fontFamily: inter } = loadInter("normal", {
  weights: ["400", "500", "700"],
  subsets: ["latin"],
});

const { fontFamily: playfairDisplay } = loadPlayfairDisplay("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

const { fontFamily: oswald } = loadOswald("normal", {
  weights: ["700"],
  subsets: ["latin"],
});

const { fontFamily: merriweather } = loadMerriweather("normal", {
  weights: ["700", "900"],
  subsets: ["latin"],
});

const { fontFamily: spaceGrotesk } = loadSpaceGrotesk("normal", {
  weights: ["700"],
  subsets: ["latin"],
});

// RTL (Farsi/Arabic) caption face. The caption fonts above are loaded with the
// "latin" subset only, so Persian glyphs (U+0600-06FF) fall outside every
// registered @font-face unicode-range and the browser substitutes a system font.
// Vazirmatn supplies the "arabic" subset at the weights the caption styles use,
// plus Latin so a brand name inside a Farsi chunk renders in one consistent face.
const { fontFamily: vazirmatn } = loadVazirmatn("normal", {
  weights: ["500", "700", "900"],
  subsets: ["arabic", "latin"],
});

export const CAPTION_FONTS = {
  montserrat,
  inter,
  playfairDisplay,
  oswald,
} as const;

/** Applied to RTL caption chunks (Farsi/Arabic text) instead of the style font. */
export const RTL_CAPTION_FONT = vazirmatn;

/** Maps archetype textCardFont names to registered Remotion font families */
export const TEXT_CARD_FONTS: Record<string, string> = {
  Inter: inter,
  Merriweather: merriweather,
  "Space Grotesk": spaceGrotesk,
};
