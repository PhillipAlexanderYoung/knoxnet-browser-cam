import QRCode from "qrcode";

export async function qrDataUrl(value: string): Promise<string> {
  return QRCode.toDataURL(value, {
    width: 220,
    margin: 1,
    color: {
      dark: "#0a0b0d",
      light: "#ffffff",
    },
    errorCorrectionLevel: "M",
  });
}
