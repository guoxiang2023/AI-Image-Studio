// Long-lived OCR helper for macOS. Vision's text recognizer loads its models on
// the first request (measured ~9-11 s); every later request is 300-1600 ms.
// Spawning one process per page would pay that cold start every time, so this
// binary stays alive and serves newline-delimited JSON on stdin.
//
//   request:  {"id":1,"image":"<base64 png/jpeg>"}
//   response: {"id":1,"text":"...","lines":12,"ms":312}
//   error:    {"id":1,"error":"..."}
//
// One request per line, one response per line, in order. The process exits when
// stdin closes. Base64 on stdin keeps the parent from staging temp files.
import AppKit
import Foundation
import Vision

func recognize(data: Data) throws -> (String, Int) {
    guard let image = NSImage(data: data),
          let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
    else {
        throw NSError(
            domain: "luma.ocr", code: 1,
            userInfo: [NSLocalizedDescriptionKey: "无法解码图片数据"])
    }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    // Chinese first: the app's documents are Chinese with Latin technical terms,
    // and this order makes Vision prefer Han glyphs for ambiguous strokes.
    request.recognitionLanguages = ["zh-Hans", "en-US"]

    try VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([request])

    let observations = request.results ?? []
    var lines: [String] = []
    for observation in observations {
        guard let candidate = observation.topCandidates(1).first else { continue }
        let text = candidate.string.trimmingCharacters(in: .whitespaces)
        if !text.isEmpty { lines.append(text) }
    }
    return (lines.joined(separator: "\n"), lines.count)
}

func emit(_ payload: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
          let line = String(data: data, encoding: .utf8)
    else { return }
    print(line)
    // `print` flushes on a terminal but is line-buffered when piped; the parent
    // blocks on each response, so make it explicit.
    fflush(stdout)
}

while let raw = readLine(strippingNewline: true) {
    let line = raw.trimmingCharacters(in: .whitespaces)
    if line.isEmpty { continue }
    guard let encoded = line.data(using: .utf8),
          let parsed = try? JSONSerialization.jsonObject(with: encoded) as? [String: Any],
          let id = parsed["id"] as? Int,
          let base64 = parsed["image"] as? String,
          let imageData = Data(base64Encoded: base64)
    else {
        emit(["id": -1, "error": "请求格式不正确"])
        continue
    }
    let started = Date()
    do {
        let (text, lines) = try recognize(data: imageData)
        emit([
            "id": id,
            "text": text,
            "lines": lines,
            "ms": Int(Date().timeIntervalSince(started) * 1000),
        ])
    } catch {
        emit(["id": id, "error": error.localizedDescription])
    }
}