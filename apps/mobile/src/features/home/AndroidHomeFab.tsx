import type { ReactNode } from "react";
import { Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { MaterialNewThreadButton } from "../../components/MaterialNewThreadButton";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

/**
 * Android-only wrapper that overlays a bottom-right new-task FAB on a thread
 * list. Other platforms render children unchanged.
 */
export function AndroidHomeFabLayout(props: {
  readonly onStartNewTask: () => void;
  readonly children: ReactNode;
  readonly sidebar?: boolean;
}) {
  if (Platform.OS !== "android") {
    return <>{props.children}</>;
  }

  return <AndroidHomeFab {...props} />;
}

function AndroidHomeFab(props: {
  readonly onStartNewTask: () => void;
  readonly children: ReactNode;
  readonly sidebar?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const { materialYouStyleLayoutActive } = useAppearancePreferences();
  return (
    <View className="flex-1">
      {props.children}
      {materialYouStyleLayoutActive ? (
        <MaterialNewThreadButton
          extended
          onPress={props.onStartNewTask}
          className="absolute right-5"
          style={{
            // Match the adjacent collapsed composer's safe inset and 6dp padding.
            bottom: props.sidebar
              ? Math.max(insets.bottom, 12) + 6
              : Math.max(insets.bottom, 16) + 16,
          }}
        />
      ) : (
        <Pressable
          accessibilityLabel="New task"
          accessibilityRole="button"
          onPress={props.onStartNewTask}
          className="absolute right-5 size-14 items-center justify-center rounded-full bg-primary shadow-lg"
          style={{ bottom: Math.max(insets.bottom, 16) + 16 }}
        >
          <SymbolView
            name="square.and.pencil"
            size={22}
            tintColorClassName={"accent-primary-foreground"}
            type="monochrome"
          />
        </Pressable>
      )}
    </View>
  );
}
