import {
  Host,
  SegmentedButton,
  SingleChoiceSegmentedButtonRow,
  Text,
} from "@expo/ui/jetpack-compose";
import { defaultMinSize, fillMaxWidth } from "@expo/ui/jetpack-compose/modifiers";
import { View } from "react-native";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { useScaledTextRole } from "../features/settings/appearance/useScaledTextRole";
import type { SegmentedControlProps } from "./SegmentedControl";

export function MaterialSegmentedControl<Value extends number | string>(
  props: SegmentedControlProps<Value>,
) {
  const { themeAppearance, themeVariables: colors } = useAppearancePreferences();
  const typography = useScaledTextRole("footnote");
  return (
    <View className={props.className}>
      <View importantForAccessibility="no-hide-descendants">
        <Host
          matchContents={{ vertical: true }}
          colorScheme={themeAppearance}
          ignoreSafeAreaKeyboardInsets
          style={{ width: "100%" }}
        >
          <SingleChoiceSegmentedButtonRow modifiers={[fillMaxWidth()]}>
            {props.options.map((option) => (
              <SegmentedButton
                key={String(option.value)}
                selected={option.value === props.selected}
                onClick={() => props.onSelect(option.value)}
                modifiers={[defaultMinSize({ minHeight: 48 })]}
                colors={{
                  activeContainerColor: colors["--color-secondary"],
                  activeContentColor: colors["--color-secondary-foreground"],
                  inactiveContainerColor: colors["--color-card"],
                  inactiveContentColor: colors["--color-foreground"],
                  activeBorderColor: colors["--color-border"],
                  inactiveBorderColor: colors["--color-border"],
                }}
              >
                <SegmentedButton.Label>
                  <Text style={typography}>{option.label}</Text>
                </SegmentedButton.Label>
              </SegmentedButton>
            ))}
          </SingleChoiceSegmentedButtonRow>
        </Host>
      </View>
      <View pointerEvents="none" className="absolute inset-0 flex-row">
        {props.options.map((option) => (
          <View
            key={String(option.value)}
            accessible
            accessibilityRole="button"
            accessibilityLabel={option.accessibilityLabel ?? option.label}
            accessibilityState={{ selected: option.value === props.selected }}
            accessibilityActions={[{ name: "activate" }]}
            onAccessibilityAction={() => props.onSelect(option.value)}
            className="flex-1"
          />
        ))}
      </View>
    </View>
  );
}
