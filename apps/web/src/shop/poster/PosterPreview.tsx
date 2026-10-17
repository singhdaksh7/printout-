import type { Poster } from './layout';
import { qrPath, roundedRectPath } from './paths';

const FONT = 'Helvetica, Arial, "Liberation Sans", sans-serif';

/**
 * On-screen preview: the same drawing operations as the PDF, rendered as inline SVG. All text goes through React
 * (escaped), nothing is injected as markup, and no image is ever fetched.
 */
export function PosterPreview({ poster, label }: { poster: Poster; label: string }) {
  return (
    <svg className="pb-poster-svg" viewBox={`0 0 ${poster.width} ${poster.height}`} role="img" aria-label={label} data-testid="poster-preview" preserveAspectRatio="xMidYMid meet">
      <rect width={poster.width} height={poster.height} fill="#FFFFFF" />
      {poster.ops.map((op, i) => {
        if (op.k === 'rect') {
          return op.r > 0.01
            ? <path key={i} transform={`translate(${op.x} ${op.y})`} d={roundedRectPath(op.w, op.h, op.r)} fill={op.fill ?? 'none'} stroke={op.stroke} strokeWidth={op.strokeW} />
            : <rect key={i} x={op.x} y={op.y} width={op.w} height={op.h} fill={op.fill ?? 'none'} stroke={op.stroke} strokeWidth={op.strokeW} />;
        }
        if (op.k === 'path') return <path key={i} transform={`translate(${op.x} ${op.y}) scale(${op.scale})`} d={op.d} fill={op.fill} />;
        if (op.k === 'qr') return <path key={i} transform={`translate(${op.x} ${op.y})`} d={qrPath(op)} fill={op.color} shapeRendering="crispEdges" data-testid="poster-qr" />;
        return (
          <text key={i} x={op.x} y={op.y} fontSize={op.size} fontWeight={op.bold ? 700 : 400} fontFamily={FONT} fill={op.color} textAnchor={op.align === 'center' ? 'middle' : 'start'}>{op.text}</text>
        );
      })}
    </svg>
  );
}
