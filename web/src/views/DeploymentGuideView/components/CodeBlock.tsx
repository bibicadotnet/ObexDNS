import React, { useState } from "react";

interface CodeBlockProps {
  code: string;
  copyText: string;
  copiedText: string;
}

export const CodeBlock: React.FC<CodeBlockProps> = ({ code, copyText, copiedText }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error("Failed to copy text:", e);
    }
  };

  return (
    <div className="relative group my-2 bg-zinc-950 dark:bg-black text-zinc-200 rounded-lg p-4 font-mono text-sm border border-zinc-800/80 overflow-x-auto shadow-inner">
      <pre className="whitespace-pre">{code}</pre>
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 px-2.5 py-1 text-xs rounded bg-zinc-850 hover:bg-zinc-800 text-zinc-300 hover:text-white transition duration-200 border border-zinc-700/60 flex items-center gap-1.5"
      >
        {copied ? (
          <>
            <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            <span>{copiedText}</span>
          </>
        ) : (
          <>
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
            </svg>
            <span>{copyText}</span>
          </>
        )}
      </button>
    </div>
  );
};
