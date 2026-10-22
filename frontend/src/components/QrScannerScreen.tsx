import { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Flashlight, LockKeyhole, QrCode, X } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, Chip, Label } from './ui';
import { BrandMark } from './Brand';

export function QrScannerScreen({
  visible,
  title,
  instruction,
  testID,
  onClose,
  onScanned,
}: {
  visible: boolean;
  title: string;
  instruction: string;
  testID?: string;
  onClose: () => void;
  onScanned: (data: string) => void | Promise<void>;
}) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [permission, requestPermission] = useCameraPermissions();
  const [torch, setTorch] = useState(false);
  const [locked, setLocked] = useState(false);
  const scanLocked = useRef(false);
  const previewHeight = Math.min(520, Math.max(300, height * 0.54));
  const frameSize = Math.min(238, width - 96);

  useEffect(() => {
    if (visible) {
      scanLocked.current = false;
      setLocked(false);
      setTorch(false);
    }
  }, [visible]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <View style={scannerStyles.screen}>
        <View style={[scannerStyles.topbar, { paddingTop: insets.top + 10 }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close scanner"
            onPress={onClose}
            style={scannerStyles.iconButton}
          >
            <X size={22} color="#fff" />
          </Pressable>
          <View style={scannerStyles.titleGroup}>
            <BrandMark size={30} />
            <Label weight="bold" style={scannerStyles.title}>
              {title}
            </Label>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={torch ? 'Turn flash off' : 'Turn flash on'}
            disabled={!permission?.granted}
            onPress={() => setTorch((value) => !value)}
            style={[scannerStyles.iconButton, !permission?.granted && { opacity: 0.35 }]}
          >
            <Flashlight size={19} color="#fff" />
          </Pressable>
        </View>

        <View style={[scannerStyles.preview, { height: previewHeight }]}>
          {permission?.granted ? (
            <CameraView
              testID={testID}
              facing="back"
              enableTorch={torch}
              style={StyleSheet.absoluteFill}
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={
                locked
                  ? undefined
                  : async ({ data }) => {
                      // Camera frames can report the same QR multiple times before
                      // React commits the locked state. Lock synchronously so a
                      // duplicate scan cannot start and cancel an Android WiFi
                      // network chooser that is already in progress.
                      if (scanLocked.current) return;
                      scanLocked.current = true;
                      setLocked(true);
                      await onScanned(data);
                    }
              }
            />
          ) : (
            <View style={[StyleSheet.absoluteFill, scannerStyles.permissionBackdrop]}>
              <QrCode size={46} color="#FFFFFF66" />
            </View>
          )}
          <View
            pointerEvents="none"
            style={[
              scannerStyles.scanFrame,
              {
                width: frameSize,
                height: frameSize,
                marginLeft: -frameSize / 2,
                marginTop: -frameSize / 2,
              },
            ]}
          >
            <View style={[scannerStyles.corner, scannerStyles.topLeft]} />
            <View style={[scannerStyles.corner, scannerStyles.topRight]} />
            <View style={[scannerStyles.corner, scannerStyles.bottomLeft]} />
            <View style={[scannerStyles.corner, scannerStyles.bottomRight]} />
            <QrCode size={40} color="#FFFFFFA8" strokeWidth={1.5} />
          </View>
          <Chip tone={permission?.granted ? 'green' : 'muted'}>
            {permission?.granted ? (locked ? 'QR detected' : 'Searching') : 'Camera off'}
          </Chip>
        </View>

        <View style={[scannerStyles.copy, { paddingBottom: Math.max(insets.bottom + 20, 28) }]}>
          <Label weight="bold" style={{ color: '#fff', fontSize: 19, textAlign: 'center' }}>
            {permission?.granted ? 'Align the QR inside the frame' : 'Camera permission required'}
          </Label>
          <Label style={scannerStyles.instruction}>
            {permission?.granted
              ? instruction
              : 'Camera access is used only while this QR scanner is open.'}
          </Label>
          {!permission?.granted && (
            <Button onPress={() => void requestPermission()}>Allow camera</Button>
          )}
          <View style={scannerStyles.securityNote}>
            <LockKeyhole size={13} color="#FFFFFF70" />
            <Label style={{ color: '#FFFFFF70', fontSize: 9 }}>
              QR codes identify a CoopGuard farm or device. They do not contain account passwords.
            </Label>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const scannerStyles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0E1712' },
  topbar: {
    minHeight: 76,
    paddingHorizontal: 17,
    paddingBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  iconButton: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: '#FFFFFF14',
    borderWidth: 1,
    borderColor: '#FFFFFF33',
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleGroup: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  title: { color: '#fff', textAlign: 'center', fontSize: 13 },
  preview: {
    marginHorizontal: 16,
    marginTop: 8,
    borderRadius: 22,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 20,
    backgroundColor: '#26352D',
  },
  permissionBackdrop: { alignItems: 'center', justifyContent: 'center' },
  scanFrame: {
    position: 'absolute',
    left: '50%',
    top: '50%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  corner: { position: 'absolute', width: 42, height: 42, borderColor: '#fff' },
  topLeft: { left: 0, top: 0, borderLeftWidth: 4, borderTopWidth: 4, borderTopLeftRadius: 12 },
  topRight: {
    right: 0,
    top: 0,
    borderRightWidth: 4,
    borderTopWidth: 4,
    borderTopRightRadius: 12,
  },
  bottomLeft: {
    left: 0,
    bottom: 0,
    borderLeftWidth: 4,
    borderBottomWidth: 4,
    borderBottomLeftRadius: 12,
  },
  bottomRight: {
    right: 0,
    bottom: 0,
    borderRightWidth: 4,
    borderBottomWidth: 4,
    borderBottomRightRadius: 12,
  },
  copy: { flex: 1, justifyContent: 'center', gap: 12, paddingHorizontal: 22, paddingTop: 18 },
  instruction: { color: '#FFFFFFA0', textAlign: 'center', fontSize: 12, lineHeight: 18 },
  securityNote: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    marginTop: 2,
  },
});
