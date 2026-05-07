const KpiCard = ({ label, icon, value, suffix, delta, sparkData = [], color = '#E59A1B' }) => {
  const max = Math.max(...sparkData, 1);
  const min = Math.min(...sparkData, 0);
  const w = 220, h = 36;
  const points = sparkData.map((v, i) => {
    const x = (i / (sparkData.length - 1)) * w;
    const y = h - ((v - min) / (max - min || 1)) * (h - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  return (
    <Card style={{display:'flex', flexDirection:'column', gap:8}}>
      <div style={{display:'flex', alignItems:'center', justifyContent:'space-between'}}>
        <Eyebrow>{label}</Eyebrow>
        <Icon name={icon} size={14} style={{color:'#B8895A'}} />
      </div>
      <div style={{font:'500 44px/48px Fraunces', color:'#F2EBDD', fontVariantNumeric:'tabular-nums', letterSpacing:'-0.02em'}}>
        {value}
        {suffix && <span style={{fontSize:22, color:'#B8B0A0', marginLeft:2}}>{suffix}</span>}
      </div>
      {delta && <div style={{fontSize:11, color: delta.startsWith('+') ? '#A8C0A8' : '#6F6A60'}}>{delta}</div>}
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height="36" preserveAspectRatio="none" style={{marginTop:4}}>
        <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round"/>
      </svg>
    </Card>
  );
};

window.KpiCard = KpiCard;
