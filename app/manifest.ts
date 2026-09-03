import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Sowmorrow",
    short_name: "Sowmorrow",
    description:
      "Gift a Coinbase tokenized stock on Base. Plant it now, then let the recipient claim it on the date you choose.",
    start_url: "/",
    display: "standalone",
    background_color: "#1b3fae",
    theme_color: "#2a6b34",
    icons: [
      { src: "/icon3.png", sizes: "192x192", type: "image/png" },
      { src: "/icon4.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
