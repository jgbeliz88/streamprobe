"use client";

import dynamic from "next/dynamic";

const StreamProbe = dynamic(() => import("@/components/StreamProbe"), {
  ssr: false,
});

export default function Page() {
  return <StreamProbe />;
}
