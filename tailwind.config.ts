import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./hooks/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: "#0B0E16",
        sf1: "#141820",
        sf2: "#1C2030",
        sf3: "#232B3E",
        bd: "#252D3D",
        bd2: "#2E3A50",
        tx1: "#E2E8F2",
        tx2: "#6B7A95",
        tx3: "#3D4B63",
        ga: "#1DB953",
        gb: "#3B82F6",
        warn: "#F59E0B",
        err: "#EF4444",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "sans-serif"],
        mono: ["var(--font-jetbrains)", "monospace"],
      },
      keyframes: {
        blink: {
          "0%,100%": { opacity: "1" },
          "50%": { opacity: "0.4" },
        },
      },
      animation: {
        "blink-slow": "blink 2s infinite",
        "blink-med": "blink 1.5s infinite",
        "blink-fast": "blink 0.5s infinite",
        "blink-load": "blink 0.8s infinite",
      },
    },
  },
  plugins: [],
};

export default config;
