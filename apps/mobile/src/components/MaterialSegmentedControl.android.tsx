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
  );
}
