"use client";

import { Fragment } from "react";
import { parseWhatsAppFormatting } from "@/lib/ai/whatsapp-format";

/** Message text with WhatsApp's own markup (*bold*, _italic_, ~strike~)
 *  rendered the way the customer sees it on their phone. */
export function WhatsAppText({ text }: { text: string }) {
  return (
    <>
      {parseWhatsAppFormatting(text).map((seg, i) => {
        if (seg.bold) return <strong key={i} className="font-semibold">{seg.text}</strong>;
        if (seg.italic) return <em key={i}>{seg.text}</em>;
        if (seg.strike) return <s key={i}>{seg.text}</s>;
        return <Fragment key={i}>{seg.text}</Fragment>;
      })}
    </>
  );
}
