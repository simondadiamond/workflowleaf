import { findErrorTraceId } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { cn } from "../../lib/cn";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  deregisterManagedRelayEnvironmentCommand,
  useManagedRelayEnvironments,
} from "./managedRelayState";

const linkedAtFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function linkedAtLabel(value: string): string {
  const linkedAt = new Date(value);
  return Number.isNaN(linkedAt.getTime())
    ? "Link date unavailable"
    : `Linked ${linkedAtFormatter.format(linkedAt)}`;
}

function endpointLabel(environment: RelayClientEnvironmentRecord): string {
  return environment.endpoint.providerKind === "cloudflare_tunnel"
    ? "Managed tunnel"
    : "Activity publishing only";
}

function confirmDeregister(environment: RelayClientEnvironmentRecord, onConfirm: () => void) {
  const title = "Deregister server?";
  const message = `“${environment.label}” will be removed from this account. T3 Connect access will be revoked, any managed tunnel will be removed, and a host space will become available. Local connections on your devices are not changed.`;
  if (process.env.EXPO_OS === "ios") {
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      { text: "Deregister", style: "destructive", onPress: onConfirm },
    ]);
    return;
  }
  showConfirmDialog({ title, message, confirmText: "Deregister", destructive: true, onConfirm });
}

/**
 * The "T3 Connect" custom page inside Clerk's native user profile: every
 * environment registered to the signed-in account, with account-level
 * deregistration. Mirrors the web UserButton page; connections on this device
 * are managed in Settings instead.
 */
export function T3ConnectProfilePage() {
  const environmentsState = useManagedRelayEnvironments();
  const deregisterEnvironment = useAtomCommand(deregisterManagedRelayEnvironmentCommand, {
    reportFailure: false,
  });
  const [deregisteringEnvironmentId, setDeregisteringEnvironmentId] =
    useState<EnvironmentId | null>(null);
  const mutationPendingRef = useRef(false);
  // Deregistered rows stay in the cached list until the refresh lands, so hide
  // them by the linkedAt they had. A re-link produces a new linkedAt and shows again.
  const [removedEnvironments, setRemovedEnvironments] = useState<{
    readonly accountId: string | null;
    readonly linkedAtById: ReadonlyMap<EnvironmentId, string>;
  }>({ accountId: null, linkedAtById: new Map() });

  const handleDeregister = useCallback(
    async (environment: RelayClientEnvironmentRecord) => {
      const accountId = environmentsState.accountId;
      if (!accountId || mutationPendingRef.current) return;

      mutationPendingRef.current = true;
      setDeregisteringEnvironmentId(environment.environmentId);
      const result = await deregisterEnvironment({
        accountId,
        environmentId: environment.environmentId,
      });
      mutationPendingRef.current = false;
      setDeregisteringEnvironmentId(null);

      if (result._tag === "Success") {
        setRemovedEnvironments((current) => {
          const linkedAtById = new Map(current.accountId === accountId ? current.linkedAtById : []);
          linkedAtById.set(environment.environmentId, environment.linkedAt);
          return { accountId, linkedAtById };
        });
        environmentsState.refresh();
        return;
      }
      if (isAtomCommandInterrupted(result)) return;

      const cause = squashAtomCommandFailure(result);
      const message = cause instanceof Error ? cause.message : "Could not deregister the server.";
      const traceId = findErrorTraceId(cause);
      console.error("[t3-connect] Could not deregister environment", {
        environmentId: environment.environmentId,
        message,
        traceId,
        cause,
      });
      Alert.alert(
        "Could not deregister server",
        traceId ? `${message}\n\nTrace ID: ${traceId}` : message,
        traceId
          ? [
              {
                text: "Copy trace ID",
                onPress: () => copyTextWithHaptic(traceId, { target: "connection-trace-id" }),
              },
              { text: "OK", style: "cancel" },
            ]
          : undefined,
      );
    },
    [deregisterEnvironment, environmentsState],
  );

  const removedEnvironmentLinkedAt =
    removedEnvironments.accountId === environmentsState.accountId
      ? removedEnvironments.linkedAtById
      : new Map<EnvironmentId, string>();
  const environments = (environmentsState.data ?? []).filter(
    (environment) =>
      removedEnvironmentLinkedAt.get(environment.environmentId) !== environment.linkedAt,
  );
  const isInitialLoad =
    !environmentsState.accountId || (environmentsState.data === null && !environmentsState.error);
  const errorTraceId = environmentsState.errorTraceId;

  return (
    <ScrollView
      className="flex-1 bg-sheet"
      contentContainerClassName="gap-3 px-4 pb-10 pt-4"
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
    >
      <View className="flex-row items-start justify-between gap-3 px-1">
        <Text className="min-w-0 flex-1 text-sm leading-normal text-foreground-muted">
          Environments registered to your account. Connections on this device are managed in
          Settings.
        </Text>
        <Pressable
          accessibilityLabel="Refresh"
          accessibilityRole="button"
          disabled={environmentsState.isPending || deregisteringEnvironmentId !== null}
          onPress={environmentsState.refresh}
          className="h-9 w-9 items-center justify-center rounded-full bg-subtle active:opacity-70 disabled:opacity-50"
        >
          {environmentsState.isPending ? (
            <ActivityIndicator colorClassName={"accent-icon"} size="small" />
          ) : (
            <SymbolView
              name="arrow.clockwise"
              size={14}
              tintColorClassName={"accent-icon"}
              type="monochrome"
            />
          )}
        </Pressable>
      </View>

      {environmentsState.error ? (
        <View collapsable={false} className="gap-3 rounded-[24px] bg-card p-5">
          <Text className="text-base font-t3-bold text-foreground">
            Could not load T3 Connect environments
          </Text>
          <Text className="text-sm text-foreground-muted">{environmentsState.error}</Text>
          {errorTraceId ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                copyTextWithHaptic(errorTraceId, { target: "connection-trace-id" });
              }}
              className="self-start flex-row items-center gap-1.5 rounded-full bg-subtle px-3 py-2 active:opacity-70"
            >
              <SymbolView
                name="doc.on.doc"
                size={12}
                tintColorClassName={"accent-icon"}
                type="monochrome"
              />
              <Text className="text-xs font-t3-bold text-foreground">Copy trace ID</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {isInitialLoad ? (
        <View collapsable={false} className="items-center gap-3 rounded-[24px] bg-card p-6">
          <ActivityIndicator colorClassName={"accent-icon"} />
          <Text className="text-center text-sm leading-normal text-foreground-muted">
            Loading environments.
          </Text>
        </View>
      ) : environments.length > 0 ? (
        <View collapsable={false} className="overflow-hidden rounded-[24px] bg-card">
          {environments.map((environment, index) => (
            <T3ConnectEnvironmentRow
              key={environment.environmentId}
              borderTop={index !== 0}
              environment={environment}
              isDeregistering={deregisteringEnvironmentId === environment.environmentId}
              mutationPending={deregisteringEnvironmentId !== null}
              onDeregister={() =>
                confirmDeregister(environment, () => void handleDeregister(environment))
              }
            />
          ))}
        </View>
      ) : environmentsState.error ? null : (
        <View collapsable={false} className="rounded-[24px] bg-card p-5">
          <Text className="text-base font-t3-bold text-foreground">No T3 Connect environments</Text>
          <Text className="mt-1 text-sm leading-normal text-foreground-muted">
            Link an environment from its local Settings to make it available through T3 Connect.
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

function T3ConnectEnvironmentRow(props: {
  readonly borderTop: boolean;
  readonly environment: RelayClientEnvironmentRecord;
  readonly isDeregistering: boolean;
  readonly mutationPending: boolean;
  readonly onDeregister: () => void;
}) {
  const { environment } = props;
  return (
    <View
      collapsable={false}
      className={cn(
        "flex-row items-center gap-3 bg-card px-4 py-3.5",
        props.borderTop && "border-t border-border",
      )}
    >
      <View className="min-w-0 flex-1 gap-0.5">
        <Text
          className="min-w-0 text-base font-t3-bold leading-snug text-foreground"
          numberOfLines={1}
        >
          {environment.label}
        </Text>
        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
          {linkedAtLabel(environment.linkedAt)} · {endpointLabel(environment)}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        disabled={props.mutationPending}
        onPress={props.onDeregister}
        className="min-w-24 items-center rounded-full bg-danger px-3.5 py-2 active:opacity-70 disabled:opacity-50"
      >
        {props.isDeregistering ? (
          <ActivityIndicator colorClassName={"accent-danger-foreground"} size="small" />
        ) : (
          <Text className="text-xs font-t3-bold text-danger-foreground">Deregister</Text>
        )}
      </Pressable>
    </View>
  );
}
