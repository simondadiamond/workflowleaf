import type { ComponentProps } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MaterialNewThreadButton } from "../../components/MaterialNewThreadButton";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { AndroidHomeFabLayout as SharedAndroidHomeFabLayout } from "./AndroidHomeFab.shared";

export function AndroidHomeFabLayout(props: ComponentProps<typeof SharedAndroidHomeFabLayout>) {
  const { materialYouStyleLayoutActive } = useAppearancePreferences();
  const insets = useSafeAreaInsets();
  if (!materialYouStyleLayoutActive) return <SharedAndroidHomeFabLayout {...props} />;
  return (
    <View className="flex-1">
      {props.children}
      <MaterialNewThreadButton
        extended
        onPress={props.onStartNewTask}
        className="absolute right-5"
        style={{
          bottom: props.sidebar
            ? Math.max(insets.bottom, 12) + 6
            : Math.max(insets.bottom, 16) + 16,
        }}
      />
    </View>
  );
}
