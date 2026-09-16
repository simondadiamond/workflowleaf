import { Host, IconButton } from "@expo/ui/jetpack-compose";
import { size } from "@expo/ui/jetpack-compose/modifiers";
import { View } from "react-native";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { SymbolView, type AppSymbolName } from "./AppSymbol";

export function MaterialIconButton(props: {
  readonly accessibilityLabel: string;
  readonly icon: AppSymbolName;
  readonly onPress?: () => void;
  readonly disabled?: boolean;
}) {
  const { themeAppearance } = useAppearancePreferences();
  return (
    <View
      accessible
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(props.disabled) }}
      accessibilityActions={[{ name: "activate" }]}
      onAccessibilityAction={() => {
        if (!props.disabled) props.onPress?.();
      }}
      style={{ width: 48, height: 48 }}
    >
      <View importantForAccessibility="no-hide-descendants">
        <Host colorScheme={themeAppearance} style={{ width: 48, height: 48 }}>
          <IconButton onClick={props.onPress} enabled={!props.disabled} modifiers={[size(48, 48)]}>
            {null}
          </IconButton>
        </Host>
      </View>
      <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
        <SymbolView
          name={props.icon}
          size={24}
          tintColorClassName={props.disabled ? "accent-icon-subtle" : "accent-foreground"}
          type="monochrome"
        />
      </View>
    </View>
  );
}
