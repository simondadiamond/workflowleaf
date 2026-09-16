import { useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView, type AppSymbolName } from "./AppSymbol";
import { AppText as Text } from "./AppText";
import { cn } from "../lib/cn";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { MaterialIconButton } from "./MaterialIconButton";
import { AndroidAnchoredMenu } from "./AndroidAnchoredMenu";
import { useScaledTextRole } from "../features/settings/appearance/useScaledTextRole";

export interface AndroidHeaderAction {
  readonly accessibilityLabel: string;
  readonly icon: AppSymbolName;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly selected?: boolean;
}

export function AndroidHeaderIconButton(props: {
  readonly accessibilityLabel: string;
  readonly icon: AppSymbolName;
  readonly onPress?: () => void;
  readonly disabled?: boolean;
  readonly selected?: boolean;
}) {
  const { materialYouStyleLayoutActive } = useAppearancePreferences();
  if (materialYouStyleLayoutActive)
    return <MaterialIconButton {...props} variant={props.selected ? "tonal" : "standard"} />;
  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(props.disabled), selected: props.selected }}
      disabled={props.disabled}
      hitSlop={8}
      onPress={props.onPress}
      className={cn(
        "size-11 items-center justify-center rounded-full bg-subtle",
        props.disabled && "opacity-55",
      )}
    >
      <SymbolView
        name={props.icon}
        size={20}
        tintColorClassName={props.disabled ? "accent-icon-subtle" : "accent-foreground"}
        type="monochrome"
      />
    </Pressable>
  );
}

export function AndroidScreenHeader(props: {
  readonly title: string;
  readonly subtitle?: string | null;
  readonly actions?: ReadonlyArray<AndroidHeaderAction>;
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
  readonly onBack?: () => void;
  readonly embedded?: boolean;
  readonly hideBottomBorder?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const titleTypography = useScaledTextRole("title");
  const subtitleTypography = useScaledTextRole("label");
  const { materialYouStyleLayoutActive } = useAppearancePreferences();
  const [headerWidth, setHeaderWidth] = useState(0);
  const actions = props.actions ?? [];
  const directCount =
    materialYouStyleLayoutActive && actions.length > 2
      ? headerWidth >= 600
        ? 3
        : 1
      : actions.length;
  const visibleActions = actions.slice(0, directCount);
  const overflowActions = actions.slice(directCount);

  return (
    <View
      onLayout={(event) => setHeaderWidth(event.nativeEvent.layout.width)}
      className={
        materialYouStyleLayoutActive
          ? "border-b border-header-border bg-header px-2 pb-2"
          : "border-b border-header-border bg-header px-3 pb-2.5"
      }
      style={{
        paddingTop: props.embedded ? 8 : Math.max(insets.top, 12),
        borderBottomWidth: props.hideBottomBorder ? 0 : undefined,
      }}
    >
      <View
        className={
          materialYouStyleLayoutActive
            ? "min-h-14 flex-row items-center gap-1"
            : "min-h-12 flex-row items-center gap-2"
        }
      >
        {props.onBack ? (
          materialYouStyleLayoutActive ? (
            <MaterialIconButton
              accessibilityLabel="Navigate up"
              icon="arrow.left"
              onPress={props.onBack}
            />
          ) : (
            <Pressable
              accessibilityLabel="Navigate up"
              accessibilityRole="button"
              hitSlop={8}
              onPress={props.onBack}
              className="-mr-2 size-11 items-center justify-center"
            >
              <SymbolView
                name="chevron.left"
                size={24}
                tintColorClassName={"accent-foreground"}
                type="monochrome"
              />
            </Pressable>
          )
        ) : null}

        {props.leading}

        <View className={cn("min-w-0 flex-1", !props.onBack && "pl-1")}>
          <Text
            numberOfLines={1}
            style={materialYouStyleLayoutActive ? titleTypography : undefined}
            className={
              materialYouStyleLayoutActive
                ? "text-foreground"
                : "text-lg font-t3-bold text-foreground"
            }
          >
            {props.title}
          </Text>
          {props.subtitle ? (
            <Text
              numberOfLines={1}
              style={materialYouStyleLayoutActive ? subtitleTypography : undefined}
              className="mt-px text-[13px] font-t3-medium text-foreground-muted"
            >
              {props.subtitle}
            </Text>
          ) : null}
        </View>

        {visibleActions.map((action) => (
          <AndroidHeaderIconButton
            key={action.accessibilityLabel}
            accessibilityLabel={action.accessibilityLabel}
            disabled={action.disabled}
            selected={action.selected}
            icon={action.icon}
            onPress={action.onPress}
          />
        ))}
        {overflowActions.length > 0 ? (
          <AndroidAnchoredMenu
            actions={overflowActions.map((action, index) => ({
              id: String(index),
              title: action.accessibilityLabel,
              attributes: {
                disabled: Boolean(action.disabled),
                state: action.selected ? "on" : undefined,
              },
            }))}
            onPressAction={({ nativeEvent }) =>
              overflowActions[Number(nativeEvent.event)]?.onPress()
            }
          >
            {(open) => (
              <MaterialIconButton
                accessibilityLabel="More actions"
                icon="ellipsis"
                onPress={open}
              />
            )}
          </AndroidAnchoredMenu>
        ) : null}
        {props.trailing}
      </View>
    </View>
  );
}

export function AndroidSheetHeader(
  props: Omit<Parameters<typeof AndroidScreenHeader>[0], "embedded">,
) {
  return <AndroidScreenHeader {...props} embedded />;
}
