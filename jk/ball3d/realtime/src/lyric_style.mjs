/** Fixed screen proportions: an 80 px sprite and 8 px gap at 1280 px high. */
export const LYRIC_HEIGHT_NDC=160/1280;
export const LYRIC_GAP_NDC=16/1280;

export function lyricMetrics(text,aspect) {
  const ratio=Math.max(1,String(text).length*48/64),halfH=LYRIC_HEIGHT_NDC/2;
  return {halfH,halfW:halfH*ratio/aspect,gap:LYRIC_GAP_NDC,
    textureWidth:256*ratio,textureHeight:256,fontSize:160};
}
