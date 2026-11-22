import React, { useState } from "react";
import { Globe } from "lucide-react";

export interface DomainIconProps {
  domain: string;
  className?: string;
}

/**
 * Site favicon with a neutral globe when none exists (many blocked / tracker / CDN hosts have no favicon).
 * A failed image never leaves a broken-image glyph or an empty gap that shifts the domain text.
 */
export const DomainIcon: React.FC<DomainIconProps> = React.memo(({ domain, className = "w-4 h-4" }) => {
  // Remembers which domain failed, so a component reused for another row (the details drawer) starts clean.
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const failed = failedFor === domain;

  if (failed) {
    return <Globe className={`${className} shrink-0 text-gray-400 `} aria-hidden />;
  }

  return (
    <img
      src={`/api/icon/${domain.replace(/^\*\./, "")}.ico`}
      className={`${className} rounded-sm shrink-0`}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailedFor(domain)}
    />
  );
});
DomainIcon.displayName = "DomainIcon";
