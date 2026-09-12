import { useRef, useState, type ReactNode } from "react";
import { CheckIcon, ChevronRightIcon, CopyIcon, LoaderCircle } from "lucide-react";
import type { ComputeRuntimeVerification } from "@t3tools/contracts";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import {
  runtimeSourceLabel,
  type ComputeSettingsInstallation,
} from "./computeInstallationSettingsModel";

export function ComputeInstallationRow({
  installation,
  languageName,
  selected,
  enabled,
  disabled,
  verificationKey,
  onTest,
  onUse,
  children,
  notice,
  recovery,
}: {
  installation: ComputeSettingsInstallation;
  languageName: string;
  selected: boolean;
  enabled: boolean;
  disabled: boolean;
  verificationKey: string;
  onTest: (executable: string) => Promise<ComputeRuntimeVerification>;
  onUse: () => void;
  children?: ReactNode;
  notice?: ReactNode;
  recovery?: ReactNode;
}) {
  const [test, setTest] = useState<{
    key: string;
    pending: boolean;
    result: ComputeRuntimeVerification | null;
    error: string | null;
  } | null>(null);
  const inFlight = useRef(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "installation path",
    timeout: 1600,
  });
  const visibleTest = test?.key === verificationKey ? test : null;
  const passed =
    visibleTest?.result?.readiness === "ready" && visibleTest.result.connection === "verified";
  const resultFailure =
    visibleTest?.result && !passed
      ? (visibleTest.result.message ??
        (visibleTest.result.missingRequirements.length
          ? `Missing: ${visibleTest.result.missingRequirements.join(", ")}`
          : "The connection could not be verified."))
      : null;
  const failure = visibleTest?.error ?? resultFailure ?? installation.problem;
  const runTest = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const key = verificationKey;
    setTest({ key, pending: true, result: null, error: null });
    try {
      const result = await onTest(installation.executable);
      setTest({ key, pending: false, result, error: null });
    } catch (cause) {
      setTest({
        key,
        pending: false,
        result: null,
        error: cause instanceof Error ? cause.message : "The connection test failed.",
      });
    } finally {
      inFlight.current = false;
    }
  };
  const source = runtimeSourceLabel(installation.source);
  const version = installation.version ?? visibleTest?.result?.profile.languageVersion;
  const identity = `${languageName}${version ? ` ${version}` : ""} · ${source}`;
  return (
    <div className="min-w-0 px-4 py-3" data-compute-installation={installation.executable}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
            <span className="text-foreground">
              {languageName}
              {version ? ` ${version}` : ""}
            </span>
            {selected ? <span className="text-[11px] text-muted-foreground">Default</span> : null}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{source}</p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="xs"
                  variant="ghost"
                  className={cn(passed && "text-success")}
                  disabled={!enabled || disabled || test?.pending || installation.problem !== null}
                  aria-label={`Test ${identity}`}
                  onClick={() => void runTest()}
                />
              }
            >
              {visibleTest?.pending ? (
                <>
                  <LoaderCircle className="size-3 animate-spin" /> Testing…
                </>
              ) : passed ? (
                <>
                  <CheckIcon /> Test passed
                </>
              ) : (
                "Test"
              )}
            </TooltipTrigger>
            <TooltipPopup>
              {passed ? "Test again. " : ""}Starts and closes a test session.
            </TooltipPopup>
          </Tooltip>
          {!selected ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={!enabled || disabled || test?.pending || installation.problem !== null}
              onClick={onUse}
              aria-label={`Use ${identity}`}
            >
              Use
            </Button>
          ) : null}
        </div>
      </div>
      {failure ? (
        <p className="mt-1.5 break-words text-xs text-destructive" role="alert">
          {failure}
        </p>
      ) : null}
      {notice ? <div className="mt-1.5">{notice}</div> : null}
      {recovery ? <div className="mt-1.5">{recovery}</div> : null}
      <Collapsible className="mt-0.5 text-xs text-muted-foreground">
        <CollapsibleTrigger
          className="group inline-flex cursor-pointer items-center gap-1 py-0.5 hover:text-foreground"
          aria-label={`${identity} details`}
        >
          <ChevronRightIcon aria-hidden className="size-3 group-data-panel-open:rotate-90" />{" "}
          Details
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="mt-2 space-y-2 rounded-md border border-border/50 bg-background/40 p-2">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-1 text-[11px]">
              <dt>Executable</dt>
              <dd className="group/path flex min-w-0 items-start justify-end gap-1 text-right">
                <code className="min-w-0 break-all text-foreground/85">
                  {installation.executable}
                </code>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-micro"
                        variant="ghost-muted"
                        className="shrink-0 opacity-0 group-hover/path:opacity-70 focus-visible:opacity-100 pointer-coarse:opacity-70"
                        aria-label={`Copy ${identity} path`}
                        onClick={() => void copyToClipboard(installation.executable, undefined)}
                      />
                    }
                  >
                    {isCopied ? (
                      <CheckIcon className="size-3" />
                    ) : (
                      <CopyIcon className="size-3" strokeWidth={1.5} />
                    )}
                  </TooltipTrigger>
                  <TooltipPopup>{isCopied ? "Copied" : "Copy path"}</TooltipPopup>
                </Tooltip>
              </dd>
              {visibleTest?.result?.profile.architecture ? (
                <>
                  <dt>Architecture</dt>
                  <dd className="text-right text-foreground/85">
                    {visibleTest.result.profile.architecture}
                  </dd>
                </>
              ) : null}
              {visibleTest?.result?.packages.length ? (
                <>
                  <dt>Packages</dt>
                  <dd className="break-words text-right text-foreground/85">
                    {visibleTest.result.packages
                      .map((pkg) => `${pkg.name} ${pkg.version ?? "missing"}`)
                      .join(" · ")}
                  </dd>
                </>
              ) : null}
            </dl>
            {children}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}
