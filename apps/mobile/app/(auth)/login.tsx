import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import { Text } from "@/components/ui/text";
import { TextField } from "@/components/ui/text-field";
import { Button } from "@/components/ui/button";
import { MulticaLogo } from "@/components/brand/multica-logo";
import { useAuthStore } from "@/data/auth-store";
import { mapAuthError } from "@/lib/auth-error";
import { useServerUrlStore } from "@/data/server-url";

export default function Login() {
  const sendCode = useAuthStore((s) => s.sendCode);
  const serverUrl = useServerUrlStore((s) => s.url);
  const defaultServerUrl = useServerUrlStore((s) => s.defaultUrl);
  const setServerUrl = useServerUrlStore((s) => s.setUrl);
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverOpen, setServerOpen] = useState(false);
  const [serverDraft, setServerDraft] = useState(serverUrl);

  const onSubmit = async () => {
    const trimmed = email.trim();
    if (!trimmed) return;
    void Haptics.selectionAsync();
    setSubmitting(true);
    setError(null);
    try {
      await sendCode(trimmed);
      router.push({ pathname: "/verify", params: { email: trimmed } });
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(mapAuthError(err, "Couldn't send the code. Try again."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-background">
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View className="flex-1 justify-center px-6 gap-6">
          <View className="items-center gap-3">
            <MulticaLogo size={32} />
            <View className="gap-1 items-center">
              <Text className="text-2xl font-semibold text-foreground">
                Sign in to Multica
              </Text>
              <Text className="text-sm text-muted-foreground text-center">
                Enter your email and we&apos;ll send you a verification code.
              </Text>
            </View>
          </View>

          <View className="gap-3">
            <TextField
              autoCapitalize="none"
              autoComplete="email"
              autoFocus
              keyboardType="email-address"
              placeholder="you@example.com"
              value={email}
              onChangeText={setEmail}
              onSubmitEditing={onSubmit}
              returnKeyType="send"
              editable={!submitting}
              invalid={!!error}
            />
            {error ? (
              <Text className="text-sm text-destructive">{error}</Text>
            ) : null}
          </View>

          <Button
            size="lg"
            disabled={submitting || !email.trim()}
            onPress={onSubmit}
          >
            <Text>{submitting ? "Sending..." : "Send code"}</Text>
          </Button>

          <View className="gap-2 pt-2">
            <Pressable
              onPress={() => {
                setServerDraft(serverUrl);
                setServerOpen((v) => !v);
              }}
            >
              <Text className="text-xs text-muted-foreground text-center">
                {`Server: ${serverUrl.replace(/^https?:\/\//, "") || "not set"} · ${serverOpen ? "Hide" : "Change"}`}
              </Text>
            </Pressable>
            {serverOpen ? (
              <View className="gap-2">
                <TextField
                  autoCapitalize="none"
                  keyboardType="url"
                  placeholder="https://host or http://192.168.1.10:18646"
                  value={serverDraft}
                  onChangeText={setServerDraft}
                />
                <View className="flex-row gap-2">
                  <View className="flex-1">
                    <Button
                      onPress={() => {
                        setServerDraft(serverUrl);
                        setServerOpen(false);
                      }}
                    >
                      <Text>Cancel</Text>
                    </Button>
                  </View>
                  <View className="flex-1">
                    <Button
                      onPress={() => {
                        void setServerUrl(serverDraft);
                        setServerOpen(false);
                      }}
                    >
                      <Text>Save</Text>
                    </Button>
                  </View>
                </View>
                {serverUrl !== defaultServerUrl ? (
                  <Pressable onPress={() => void setServerUrl(null)}>
                    <Text className="text-xs text-muted-foreground text-center">
                      Reset to packaged default
                    </Text>
                  </Pressable>
                ) : null}
                <Text className="text-xs text-muted-foreground text-center">
                  {"Same Wi-Fi as the desktop? Use its LAN address (http://<mac-ip>:18646) for a faster, steadier link than the public tunnel."}
                </Text>
              </View>
            ) : null}
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
