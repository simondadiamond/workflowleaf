import { useNavigation } from "@react-navigation/native";
import type { ComponentProps, ReactNode } from "react";
import { Platform, View } from "react-native";

import { AndroidScreenHeader } from "../../../components/AndroidScreenHeader";
import { MaterialScreenContent as SettingsScreenContent } from "../../../components/MaterialScreenContent";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { useAppearancePreferences } from "../appearance/AppearancePreferencesProvider";
import { AndroidWorkspaceSidebarButton } from "../../layout/workspace-sidebar-toolbar";

export { SettingsScreenContent };

export function SettingsScreen(
  props: Pick<ComponentProps<typeof AndroidScreenHeader>, "title" | "actions" | "trailing"> & {
    readonly children: ReactNode;
    /** Preserve this route's native Android header when Material You layout is off. */
    readonly nativeAndroidHeader?: boolean;
    /** A native form sheet already owns its rounded outer frame. */
    readonly formSheet?: boolean;
  },
) {
  const navigation = useNavigation();
  const { materialYouStyleLayoutActive } = useAppearancePreferences();
  const showAndroidHeader = materialYouStyleLayoutActive || !props.nativeAndroidHeader;

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: !showAndroidHeader }} />
          {showAndroidHeader ? (
            <AndroidScreenHeader
              title={props.title}
              leading={props.formSheet ? undefined : <AndroidWorkspaceSidebarButton />}
              actions={props.actions}
              trailing={props.trailing}
              onBack={() => navigation.goBack()}
              hideBottomBorder={materialYouStyleLayoutActive && !props.formSheet}
            />
          ) : null}
        </>
      ) : null}
      {props.formSheet ? (
        props.children
      ) : (
        <SettingsScreenContent>{props.children}</SettingsScreenContent>
      )}
    </View>
  );
}
