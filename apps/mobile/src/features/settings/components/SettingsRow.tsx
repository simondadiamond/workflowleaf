import { useNavigation } from "@react-navigation/native";
import type { ComponentProps } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../../components/AppSymbol";

import { AppText as Text } from "../../../components/AppText";
import type { SettingsLegalDocumentTarget, SettingsSheetTarget } from "./settings-sheet-targets";
import { useAppearancePreferences } from "../appearance/AppearancePreferencesProvider";
import { cn } from "../../../lib/cn";

type SymbolName = ComponentProps<typeof SymbolView>["name"];

export function SettingsRow(props: {
  readonly disabled?: boolean;
  readonly icon: SymbolName;
  readonly label: string;
  readonly value?: string;
  readonly target?: SettingsSheetTarget;
  readonly fullScreenTarget?: SettingsLegalDocumentTarget;
  readonly onPress?: () => void;
}) {
  const navigation = useNavigation();
  const { materialYouStyleLayoutActive, themeVariables } = useAppearancePreferences();
  const ripple = materialYouStyleLayoutActive
    ? { color: themeVariables["--color-subtle-strong"] }
    : undefined;
  const content = (
    <View
      className={cn(
        "flex-row items-center gap-4 p-4",
        materialYouStyleLayoutActive && "min-h-18",
        props.disabled && "opacity-[0.45]",
      )}
    >
      <SymbolView
        name={props.icon}
        size={materialYouStyleLayoutActive ? 24 : 22}
        tintColorClassName={"accent-icon"}
        type="monochrome"
        weight="regular"
      />
      {materialYouStyleLayoutActive ? (
        <View className="min-w-0 flex-1 gap-1">
          <Text className="text-base text-foreground">{props.label}</Text>
          {props.value ? (
            <Text className="text-sm text-foreground-muted">{props.value}</Text>
          ) : null}
        </View>
      ) : (
        <>
          <Text className="shrink-0 text-lg text-foreground" numberOfLines={1}>
            {props.label}
          </Text>
          <View className="min-w-0 flex-1 items-end">
            {props.value ? (
              <Text
                className="max-w-[180px] text-right text-base text-foreground-muted"
                ellipsizeMode="middle"
                numberOfLines={1}
              >
                {props.value}
              </Text>
            ) : null}
          </View>
        </>
      )}
      <SymbolView
        name="chevron.right"
        size={16}
        tintColorClassName={"accent-chevron"}
        type="monochrome"
        weight="semibold"
      />
    </View>
  );

  const target = props.target;
  if (target) {
    return (
      <Pressable
        android_ripple={ripple}
        accessibilityLabel={props.label}
        accessibilityRole="button"
        disabled={props.disabled}
        onPress={() =>
          navigation.navigate("SettingsSheet", {
            screen: "SettingsContent",
            params: { screen: target },
          })
        }
      >
        {content}
      </Pressable>
    );
  }

  const fullScreenTarget = props.fullScreenTarget;
  if (fullScreenTarget) {
    return (
      <Pressable
        android_ripple={ripple}
        accessibilityLabel={props.label}
        accessibilityRole="button"
        disabled={props.disabled}
        onPress={() => navigation.navigate(fullScreenTarget)}
      >
        {content}
      </Pressable>
    );
  }

  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      android_ripple={ripple}
      disabled={props.disabled}
      onPress={props.onPress}
    >
      {content}
    </Pressable>
  );
}
