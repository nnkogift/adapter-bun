import Image from "next/image";
import { AppDraftModePanel } from "../../../components/app-draft-mode-panel";

export default function AppImagePage() {
  return (
    <div>
      <h2>App Router: next/image optimization page</h2>
      <p>
        This route validates <code>next/image</code> requests through{" "}
        <code>/_next/image</code>.
      </p>
      <AppDraftModePanel returnPath="/app-router/image" />
      <p style={{ marginTop: 24 }}>
        Next.js logo rendered via <code>next/image</code>:
      </p>
      <div style={{ background: "#000", padding: 10 }}>
        <Image
          src="/images/nextjs-logo.png"
          alt="Next.js logo"
          width={158}
          height={32}
          priority
        />
      </div>
    </div>
  );
}
