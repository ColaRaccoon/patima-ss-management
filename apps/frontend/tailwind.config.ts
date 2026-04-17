import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
    "../../packages/shared/src/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "var(--font-sans)",
          "Pretendard Variable",
          "Pretendard",
          "Noto Sans KR",
          "Apple SD Gothic Neo",
          "Segoe UI",
          "system-ui",
          "sans-serif",
        ],
        mono: [
          "var(--font-mono)",
          "JetBrains Mono",
          "D2Coding",
          "ui-monospace",
          "monospace",
        ],
      },
      colors: {
        ink: {
          DEFAULT: "#172033",
          55: "#8892a2",      /* NEW: eyebrow/muted */
          65: "#5e6879",      /* NEW: secondary */
          70: "#3a4456",      /* NEW: emphasis (대비 강화) */
        },
        sand: "#f3efe5",
        coral: "#c96a4a",
        sage: "#729d87",
      },
    },
  },
  plugins: [],
};

export default config;
