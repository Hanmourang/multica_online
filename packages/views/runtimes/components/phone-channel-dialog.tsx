"use client";

import { Globe, Loader2, Smartphone, Terminal, Wifi } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { localChannelOptions } from "@multica/core/runtimes/queries";
import {
  tunnelStartCommand,
  type LocalChannel,
} from "@multica/core/runtimes/local-channel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { Button } from "@multica/ui/components/ui/button";
import { CODE_LIGATURE_CLASS } from "@multica/ui/lib/code-style";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import { CopyButton } from "./copy-button";

function AddressRow({ label, value }: { label: string; value: string }) {
  const { t } = useT("runtimes");
  return (
    <div>
      <p className="mb-1.5 text-caption font-medium text-foreground">{label}</p>
      <div className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2.5 font-mono text-body">
        <code
          className={cn(
            "min-w-0 flex-1 break-all whitespace-pre-wrap",
            CODE_LIGATURE_CLASS,
          )}
        >
          {value}
        </code>
        <CopyButton text={value} ariaLabel={t(($) => $.phone_channel.copy)} />
      </div>
    </div>
  );
}

function SectionHeading({
  icon: Icon,
  title,
  hint,
  extra,
}: {
  icon: typeof Globe;
  title: string;
  hint: string;
  extra?: React.ReactNode;
}) {
  return (
    <div className="mb-2.5 flex items-start gap-2">
      <Icon
        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="text-caption font-semibold text-foreground">{title}</p>
        <p className="mt-0.5 text-micro leading-[1.55] text-muted-foreground">
          {hint}
        </p>
      </div>
      {extra}
    </div>
  );
}

function TunnelStatusLine({ channel }: { channel: LocalChannel }) {
  const { t } = useT("runtimes");
  const { tunnel } = channel;
  if (!tunnel.detected) return null;
  return (
    <p className="mb-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-micro text-muted-foreground">
      <span
        className={cn(
          "inline-flex items-center gap-1.5 font-medium",
          tunnel.healthy ? "text-success" : "text-warning",
        )}
      >
        <span
          className={cn(
            "inline-block h-1.5 w-1.5 rounded-full",
            tunnel.healthy ? "bg-success" : "bg-warning",
          )}
          aria-hidden
        />
        {tunnel.healthy
          ? t(($) => $.phone_channel.tunnel_healthy)
          : t(($) => $.phone_channel.tunnel_unhealthy)}
      </span>
      {tunnel.source === "process" && tunnel.pid ? (
        <span>{t(($) => $.phone_channel.tunnel_running, { pid: tunnel.pid })}</span>
      ) : (
        <span>{t(($) => $.phone_channel.tunnel_external)}</span>
      )}
    </p>
  );
}

/**
 * Everything another device needs to talk to this backend. Two sections rather
 * than one list because they fail for different reasons: the public pair dies
 * with the tunnel process, the LAN pair dies with the Wi-Fi.
 */
export function PhoneChannelDialog({ onClose }: { onClose: () => void }) {
  const { t } = useT("runtimes");
  const { data: channel, isLoading } = useQuery({
    ...localChannelOptions(),
    // The operator opens this panel to set a device up, then starts the tunnel
    // in a terminal: poll so the address appears without reopening the dialog.
    // Once a healthy tunnel is found there is nothing left to watch for.
    refetchInterval: (query) =>
      query.state.data?.tunnel.healthy ? false : 10_000,
  });
  const startCommand = tunnelStartCommand(channel?.port);

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="px-6 pt-6 pb-2">
          <DialogTitle className="flex items-center gap-2 text-title-sm text-balance">
            <Smartphone className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            {t(($) => $.phone_channel.title)}
          </DialogTitle>
          <DialogDescription className="text-caption text-balance">
            {t(($) => $.phone_channel.description)}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {isLoading ? (
            <p className="flex items-center gap-2 py-6 text-caption text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              …
            </p>
          ) : (
            <div className="space-y-5">
              <section>
                <SectionHeading
                  icon={Globe}
                  title={t(($) => $.phone_channel.public_title)}
                  hint={t(($) => $.phone_channel.public_hint)}
                />
                {channel && <TunnelStatusLine channel={channel} />}
                {channel?.tunnelURL ? (
                  <div className="space-y-3">
                    <AddressRow
                      label={t(($) => $.phone_channel.api_label)}
                      value={channel.tunnelURL}
                    />
                    {channel.tunnelWSURL && (
                      <AddressRow
                        label={t(($) => $.phone_channel.ws_label)}
                        value={channel.tunnelWSURL}
                      />
                    )}
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed px-3 py-2.5">
                    <p className="text-caption font-medium text-foreground">
                      {t(($) => $.phone_channel.tunnel_missing_title)}
                    </p>
                    <p className="mt-0.5 text-micro leading-[1.55] text-muted-foreground">
                      {t(($) => $.phone_channel.tunnel_missing_hint)}
                    </p>
                    {startCommand && (
                      <div className="mt-2 flex items-start gap-2 rounded-lg bg-muted px-3 py-2.5 font-mono text-body">
                        <Terminal
                          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground"
                          aria-hidden
                        />
                        <code
                          className={cn(
                            "min-w-0 flex-1 break-all whitespace-pre-wrap",
                            CODE_LIGATURE_CLASS,
                          )}
                        >
                          {startCommand}
                        </code>
                        <CopyButton
                          text={startCommand}
                          ariaLabel={t(($) => $.phone_channel.copy)}
                        />
                      </div>
                    )}
                  </div>
                )}
              </section>

              <section>
                <SectionHeading
                  icon={Wifi}
                  title={t(($) => $.phone_channel.lan_title)}
                  hint={t(($) => $.phone_channel.lan_hint)}
                />
                {channel?.lanURL ? (
                  <div className="space-y-3">
                    <AddressRow
                      label={t(($) => $.phone_channel.api_label)}
                      value={channel.lanURL}
                    />
                    {channel.lanWSURL && (
                      <AddressRow
                        label={t(($) => $.phone_channel.ws_label)}
                        value={channel.lanWSURL}
                      />
                    )}
                  </div>
                ) : (
                  <p className="text-caption text-muted-foreground">
                    {t(($) => $.phone_channel.lan_missing)}
                  </p>
                )}
              </section>
            </div>
          )}
        </div>

        <DialogFooter className="m-0 rounded-b-xl border-t bg-muted/30 px-6 py-3">
          <Button variant="outline" size="sm" onClick={onClose}>
            {t(($) => $.phone_channel.close)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
