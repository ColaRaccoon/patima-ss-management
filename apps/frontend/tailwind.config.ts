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
      colors: {
        ink: "#172033",
        sand: "#f3efe5",
        coral: "#c96a4a",
        sage: "#729d87",
      },
    },
  },
  plugins: [],
};

export default config;
