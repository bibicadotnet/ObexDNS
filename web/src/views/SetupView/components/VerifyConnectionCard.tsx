import React, { useState } from "react";
import { Button, Spinner, Intent, PopoverNext } from "@blueprintjs/core";
import { Globe, MapPin, Eye, EyeOff, Server, ShieldAlert, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import type { ClientInfo } from "../types";
import { useDeploymentMode } from "../../../hooks/useDeploymentMode";

type VerifyResult = {
  success: boolean;
  profileMatch: boolean;
  method?: "probe" | "ip";
  transport?: "doh" | "dot" | "udp";
} | null;

export interface ConnectionBannerProps {
  isVerifying: boolean;
  verifyResult: VerifyResult;
  handleVerify: () => void;
}

/**
 * The answer to "am I protected right now?", at the very top of Setup.
 * One colour, one sentence, one button (check again). The technical details live
 * further down for the few people who want them.
 */
export const ConnectionBanner: React.FC<ConnectionBannerProps> = ({ isVerifying, verifyResult, handleVerify }) => {
  const { t } = useTranslation();
  const ok = Boolean(verifyResult?.success);
  const failed = Boolean(verifyResult) && !ok;
  const mismatch = ok && verifyResult && !verifyResult.profileMatch;

  const tone = isVerifying
    ? "border-gray-200 bg-white"
    : mismatch
      ? "border-amber-200 bg-amber-50"
      : ok
        ? "border-green-200 bg-green-50"
        : failed
          ? "border-red-200 bg-red-50"
          : "border-gray-200 bg-white";
  const iconTone = isVerifying
    ? "bg-gray-100 text-gray-600"
    : mismatch
      ? "bg-amber-100 text-amber-700"
      : ok
        ? "bg-green-100 text-green-700"
        : failed
          ? "bg-red-100 text-red-700"
          : "bg-blue-100 text-blue-700";

  return (
    <section
      className={clsx("flex flex-col gap-4 rounded-2xl border p-4 sm:flex-row sm:items-center sm:p-5", tone)}
      aria-live="polite"
    >
      <div className="flex min-w-0 flex-1 items-start gap-4">
        <span className={clsx("inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full", iconTone)}>
          {isVerifying ? <Spinner size={22} /> : ok && !mismatch ? <ShieldCheck size={24} /> : failed || mismatch ? <ShieldAlert size={24} /> : <Server size={24} />}
        </span>
        <div className="min-w-0">
          <h2 className="section-title">
            {isVerifying ? t("setup.verifying") : ok ? t("setup.connected") : t("setup.notConnected")}
          </h2>
          <p className="m-0 mt-0.5 text-sm text-gray-700">
            {ok
              ? verifyResult?.profileMatch
                ? t("setup.profileMatch")
                : t("setup.profileMismatch")
              : verifyResult
                ? t("setup.verifyNotDetected")
                : t("setup.verifyHint")}
          </p>
          {ok && verifyResult?.method === "ip" && (
            <p className="m-0 mt-1 text-xs text-gray-600">{t("setup.verifyIpFallback")}</p>
          )}
        </div>
      </div>
      <Button
        intent={ok && !mismatch ? Intent.NONE : Intent.PRIMARY}
        icon="refresh"
        text={t("setup.refreshStatus")}
        onClick={handleVerify}
        loading={isVerifying}
        className="w-full sm:w-auto"
      />
    </section>
  );
};

export interface ConnectionDetailsProps {
  clientInfo: ClientInfo | null;
  showIp: boolean;
  setShowIp: (show: boolean) => void;
  showLocation: boolean;
  setShowLocation: (show: boolean) => void;
  traceInfo?: { colo: string; raw: string } | null;
  edgeLocation?: string | null;
}

const Detail: React.FC<{ icon: React.ReactNode; label: string; action?: React.ReactNode; children: React.ReactNode }> = ({
  icon,
  label,
  action,
  children,
}) => (
  <div className="flex h-full items-start gap-3 rounded-xl border border-gray-200 bg-white p-4">
    <span className="mt-0.5 shrink-0 text-blue-600">{icon}</span>
    <div className="min-w-0 flex-1">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-semibold text-gray-500">{label}</div>
        {action}
      </div>
      <div className="mt-0.5 truncate font-semibold text-gray-900">{children}</div>
    </div>
  </div>
);

/**
 * "Where do my requests come from, and which server answers them?"
 * Your IP and location are blurred until you reveal them, so a screenshot is safe to share.
 */
export const ConnectionDetails: React.FC<ConnectionDetailsProps> = ({
  clientInfo,
  showIp,
  setShowIp,
  showLocation,
  setShowLocation,
  traceInfo,
  edgeLocation,
}) => {
  const { t } = useTranslation();
  const { isServerfull } = useDeploymentMode();
  const [isTraceOpen, setIsTraceOpen] = useState(false);

  if (!clientInfo) return null;

  const eyeButton = (shown: boolean, toggle: () => void, label: string) => (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      className="-m-2 inline-flex h-9 w-9 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-blue-700"
    >
      {shown ? <Eye size={16} /> : <EyeOff size={16} />}
    </button>
  );

  const place = [clientInfo.city, clientInfo.region, clientInfo.country].filter(
    (p): p is string => Boolean(p && p !== "UNKNOWN"),
  );

  const edgeCard = (
    <Detail icon={<Server size={18} />} label={isServerfull ? t("setup.serverLocation") : t("setup.edgeServer")}>
      <span title={edgeLocation || traceInfo?.colo || ""}>
        {isServerfull ? edgeLocation || t("setup.detecting") : edgeLocation || traceInfo?.colo || t("setup.detecting")}
      </span>
    </Detail>
  );

  return (
    <section>
      <h2 className="section-title mb-3">{t("setup.connectionDetails", "Connection details")}</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Detail
          icon={<Globe size={18} />}
          label={t("setup.egressIp")}
          action={eyeButton(showIp, () => setShowIp(!showIp), t("setup.toggleIp", "Show or hide IP address"))}
        >
          <span className={clsx("inline-block font-mono transition-[filter] duration-200", !showIp && "select-none blur-[6px]")}>
            {clientInfo.ip}
          </span>
        </Detail>
        <Detail
          icon={<MapPin size={18} />}
          label={t("setup.currentLocation")}
          action={eyeButton(showLocation, () => setShowLocation(!showLocation), t("setup.toggleLocation", "Show or hide location"))}
        >
          <span className={clsx("inline-block transition-[filter] duration-200", !showLocation && "select-none blur-[6px]")}>
            {place.length > 0 ? place.join(", ") : t("setup.detecting")}
          </span>
        </Detail>
        {!isServerfull ? (
          <PopoverNext
            isOpen={isTraceOpen}
            onInteraction={setIsTraceOpen}
            placement="bottom-end"
            portalClassName="z-20000"
            fill
            targetProps={{ className: "h-full" }}
            content={
              <div className="w-72 max-w-[85vw] space-y-2 p-3 select-text sm:w-80">
                <div className="border-b border-gray-100 pb-1.5 font-mono text-xs font-bold text-gray-500">/cdn-cgi/trace</div>
                <pre className="m-0 max-h-64 overflow-y-auto whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-gray-800">
                  {traceInfo?.raw || t("setup.noTraceData")}
                </pre>
              </div>
            }
          >
            <button type="button" className="block h-full w-full text-left">
              {edgeCard}
            </button>
          </PopoverNext>
        ) : (
          edgeCard
        )}
      </div>
    </section>
  );
};
