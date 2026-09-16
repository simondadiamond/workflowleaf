import { Box, ExtendedFloatingActionButton, Host, Text } from "@expo/ui/jetpack-compose";
import { size } from "@expo/ui/jetpack-compose/modifiers";
import type { ComponentProps } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import { AndroidHomeFabLayout as SharedAndroidHomeFabLayout } from "./AndroidHomeFab.shared";

export function AndroidHomeFabLayout(props: ComponentProps<typeof SharedAndroidHomeFabLayout>) {
  const { materialYouStyleLayoutActive } = useAppearancePreferences();
  return materialYouStyleLayoutActive ? (
    <MaterialHomeFab {...props} />
  ) : (
    <SharedAndroidHomeFabLayout {...props} />
  );
}

function MaterialHomeFab(props: ComponentProps<typeof SharedAndroidHomeFabLayout>) {
  const insets = useSafeAreaInsets();
  const { themeAppearance, themeVariables: colors } = useAppearancePreferences();
  const typography = useScaledTextRole("footnote");
  return (
    <View className="flex-1">
      {props.children}
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel="New task"
        accessibilityActions={[{ name: "activate" }]}
        onAccessibilityAction={props.onStartNewTask}
        className="absolute right-4"
        style={{ bottom: Math.max(insets.bottom, 16) + 16 }}
      >
        <View importantForAccessibility="no-hide-descendants">
          <Host matchContents colorScheme={themeAppearance} ignoreSafeAreaKeyboardInsets>
            <ExtendedFloatingActionButton
              containerColor={colors["--color-secondary"]}
              onClick={props.onStartNewTask}
            >
              <ExtendedFloatingActionButton.Icon>
                <Box modifiers={[size(24, 24)]} />
              </ExtendedFloatingActionButton.Icon>
              <ExtendedFloatingActionButton.Text>
                <Text
                  color={colors["--color-secondary-foreground"]}
                  style={{ ...typography, fontWeight: "500" }}
                >
                  New task
                </Text>
              </ExtendedFloatingActionButton.Text>
            </ExtendedFloatingActionButton>
          </Host>
        </View>
        <View
          pointerEvents="none"
          className="absolute bottom-0 top-0 justify-center"
          style={{ start: 20 }}
        >
          <SymbolView
            name="square.and.pencil"
            size={24}
            tintColorClassName="accent-secondary-foreground"
          />
        </View>
      </View>
    </View>
  );
}
