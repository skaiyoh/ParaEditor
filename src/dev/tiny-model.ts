// A one-node ONNX model built in code, for probes that need ORT to create a
// session and run without downloading real weights: `c = MatMul(a, b)` on
// float32 square matrices of side `size`. The bytes are the ONNX ModelProto
// protobuf, written field by field.

/** Field numbers from onnx.proto (ONNX IR version 8). */
const MODEL = { irVersion: 1, graph: 7, opsetImport: 8 } as const;
const OPSET = { version: 2 } as const;
const GRAPH = { node: 1, name: 2, input: 11, output: 12 } as const;
const NODE = { input: 1, output: 2, opType: 4 } as const;
const VALUE_INFO = { name: 1, type: 2 } as const;
const TYPE = { tensorType: 1 } as const;
const TENSOR_TYPE = { elemType: 1, shape: 2 } as const;
const SHAPE = { dim: 1 } as const;
const DIM = { value: 1 } as const;
const FLOAT = 1;

const encoder = new TextEncoder();

function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}

const intField = (field: number, value: number): number[] => [...varint(field << 3), ...varint(value)];
const bytesField = (field: number, bytes: readonly number[]): number[] => [...varint((field << 3) | 2), ...varint(bytes.length), ...bytes];
const stringField = (field: number, text: string): number[] => bytesField(field, [...encoder.encode(text)]);

function matrixInfo(name: string, size: number): number[] {
  const dim = bytesField(SHAPE.dim, intField(DIM.value, size));
  const tensor = [...intField(TENSOR_TYPE.elemType, FLOAT), ...bytesField(TENSOR_TYPE.shape, [...dim, ...dim])];
  return [...stringField(VALUE_INFO.name, name), ...bytesField(VALUE_INFO.type, bytesField(TYPE.tensorType, tensor))];
}

/** The model's bytes: inputs `a` and `b`, output `c`, each `size` x `size` float32. */
export function matMulModel(size: number): Uint8Array<ArrayBuffer> {
  const node = [...stringField(NODE.input, 'a'), ...stringField(NODE.input, 'b'), ...stringField(NODE.output, 'c'), ...stringField(NODE.opType, 'MatMul')];
  const graph = [
    ...bytesField(GRAPH.node, node),
    ...stringField(GRAPH.name, 'matmul'),
    ...bytesField(GRAPH.input, matrixInfo('a', size)),
    ...bytesField(GRAPH.input, matrixInfo('b', size)),
    ...bytesField(GRAPH.output, matrixInfo('c', size)),
  ];
  return new Uint8Array([
    ...intField(MODEL.irVersion, 8),
    ...bytesField(MODEL.opsetImport, intField(OPSET.version, 17)),
    ...bytesField(MODEL.graph, graph),
  ]);
}
