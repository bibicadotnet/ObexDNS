import React from "react";

/**
 * A titled group of related settings. The title and one-line description say what the
 * group is for, so people scan headings instead of reading every card.
 */
export const SettingsGroup: React.FC<{ id: string; title: string; desc?: string; children: React.ReactNode }> = ({
  id,
  title,
  desc,
  children,
}) => (
  <section id={id} className="scroll-mt-16 space-y-3">
    <header>
      <h2 className="section-title">{title}</h2>
      {desc && <p className="hint m-0 mt-0.5">{desc}</p>}
    </header>
    <div className="space-y-4">{children}</div>
  </section>
);
