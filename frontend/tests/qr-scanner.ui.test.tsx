import { expect, jest, test } from '@jest/globals';
import { act, render } from '@testing-library/react-native';
import { QrScannerScreen } from '../src/components/QrScannerScreen';

test('accepts only one QR event while a scan is being handled', async () => {
  const onScanned = jest.fn(async () => undefined);

  const view = await render(
    <QrScannerScreen
      visible
      testID="qr-camera"
      title="Scan QR"
      instruction="Align the QR code."
      onClose={() => undefined}
      onScanned={onScanned}
    />,
  );

  const camera = view.getByTestId('qr-camera');
  await act(async () => {
    const first = camera.props.onBarcodeScanned({ data: 'same-qr' });
    const duplicate = camera.props.onBarcodeScanned({ data: 'same-qr' });
    await Promise.all([first, duplicate]);
  });

  expect(onScanned).toHaveBeenCalledTimes(1);
  expect(onScanned).toHaveBeenCalledWith('same-qr');
});
