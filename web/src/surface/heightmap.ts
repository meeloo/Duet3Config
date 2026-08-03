// RepRapFirmware height map files.
//
// Format (v1 and v2 both in the wild):
//
//   RepRapFirmware height map file v2, mean error 0.08, deviation 0.17
//   xmin,xmax,ymin,ymax,radius,xspacing,yspacing,xnum,ynum
//   -60.00,60.10,-60.00,60.10,-1.00,20.00,20.00,7,7
//         0, -0.135,  0.110, …
//    -0.021, -0.016, -0.020, …
//
// v1 has a single `spacing` column instead of `xspacing,yspacing`. Rows run in
// order of increasing Y; within a row, X increases left to right.
//
// The one trap: the firmware writes `0` for a point it could NOT probe and
// `0.000` for a point that measured exactly zero. That distinction lives in the
// *text*, not the number, so the parser must look at the token — reading both as
// 0 turns a hole in the scan into a claim that the surface was perfectly flat
// there, which is the one lie a height map must not tell.

export interface HeightMap {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  xSpacing: number;
  ySpacing: number;
  xNum: number;
  yNum: number;
  /** [row][col], row 0 = lowest Y. null where the point was not probed. */
  values: Array<Array<number | null>>;
  /** Points actually probed. */
  probed: number;
  mean: number;
  /** Root-mean-square deviation from the mean. */
  deviation: number;
  min: number;
  max: number;
}

export class HeightMapError extends Error {}

function numbers(line: string): string[] {
  return line.split(',').map((s) => s.trim());
}

export function parseHeightMap(text: string): HeightMap {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (!lines.length || !/height map file/i.test(lines[0])) {
    throw new HeightMapError('not a RepRapFirmware height map file');
  }
  if (lines.length < 4) throw new HeightMapError('height map file is truncated');

  const header = numbers(lines[1]).map((h) => h.toLowerCase());
  const fields = numbers(lines[2]).map(Number);
  const pick = (name: string): number | undefined => {
    const i = header.indexOf(name);
    return i < 0 ? undefined : fields[i];
  };

  const xMin = pick('xmin');
  const xMax = pick('xmax');
  const yMin = pick('ymin');
  const yMax = pick('ymax');
  const xNum = pick('xnum');
  const yNum = pick('ynum');
  // v2 splits the spacing per axis; v1 has one column for both.
  const xSpacing = pick('xspacing') ?? pick('spacing');
  const ySpacing = pick('yspacing') ?? pick('spacing');

  if (
    xMin === undefined || xMax === undefined || yMin === undefined || yMax === undefined ||
    xNum === undefined || yNum === undefined || xSpacing === undefined || ySpacing === undefined
  ) {
    throw new HeightMapError(`unrecognised height map header: ${lines[1]}`);
  }
  if (!(xNum > 0) || !(yNum > 0)) throw new HeightMapError('height map has no points');

  const values: Array<Array<number | null>> = [];
  for (let row = 0; row < yNum; row++) {
    const line = lines[3 + row];
    if (line === undefined) throw new HeightMapError(`height map claims ${yNum} rows but has ${row}`);
    const tokens = numbers(line);
    values.push(
      Array.from({ length: xNum }, (_, col) => {
        const token = tokens[col];
        // Bare "0" means not probed; "0.000" means measured flat. See above.
        if (token === undefined || token === '0' || token === '') return null;
        const v = Number(token);
        return isFinite(v) ? v : null;
      }),
    );
  }

  const flat = values.flat().filter((v): v is number => v !== null);
  const mean = flat.length ? flat.reduce((a, b) => a + b, 0) / flat.length : 0;
  const deviation = flat.length
    ? Math.sqrt(flat.reduce((a, b) => a + (b - mean) ** 2, 0) / flat.length)
    : 0;

  return {
    xMin, xMax, yMin, yMax, xSpacing, ySpacing, xNum, yNum,
    values,
    probed: flat.length,
    mean,
    deviation,
    min: flat.length ? Math.min(...flat) : 0,
    max: flat.length ? Math.max(...flat) : 0,
  };
}

/** Work coordinates of the grid point at [row][col]. */
export function pointAt(map: HeightMap, row: number, col: number): [number, number] {
  return [map.xMin + col * map.xSpacing, map.yMin + row * map.ySpacing];
}
