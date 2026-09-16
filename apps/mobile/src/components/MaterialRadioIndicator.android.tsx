import { Host, RadioButton } from "@expo/ui/jetpack-compose";
import { size } from "@expo/ui/jetpack-compose/modifiers";
import { View } from "react-native";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";

/** The enclosing radio row owns selection, touch and accessibility. */
export function MaterialRadioIndicator({ selected }: { readonly selected: boolean }) {
  const { themeAppearance, themeVariables } = useAppearancePreferences();
  return (
    <View pointerEvents="none" importantForAccessibility="no-hide-descendants">
      <Host
        colorScheme={themeAppearance}
        seedColor={themeVariables["--color-primary"]}
        ignoreSafeAreaKeyboardInsets
        style={{ width: 24, height: 24 }}
      >
        <RadioButton selected={selected} modifiers={[size(24, 24)]} />
      </Host>
    </View>
  );
}
