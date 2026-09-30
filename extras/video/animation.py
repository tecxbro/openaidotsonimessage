"""Original frame-driven motion graphics. No network, browser, or stock assets.

Render via technical-motion-explainer/scripts/render_motion.py. This module exposes
WIDTH, HEIGHT, FPS, DURATION and render_frame(frame_number) -> RGB PIL.Image.
All animation is a pure function of frame index; seeking is deterministic.
"""
from pathlib import Path
from functools import lru_cache
import json, math
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
P = json.loads((ROOT / 'project.json').read_text())
WIDTH, HEIGHT, FPS, DURATION = P['width'], P['height'], P['fps'], P['duration']
BG=(10,14,22); PAPER=(244,246,250); WHITE=(249,251,255)
BLUE=(40,128,255); INK=(19,26,37); MUTED=(142,155,178); LINE=(49,63,84)
FONT=ROOT/'assets/fonts'

def clamp(t): return max(0., min(1., t))
def ease(t):
    t=clamp(t); return 1-(1-t)**4
def smooth(t):
    t=clamp(t); return t*t*(3-2*t)
def lerp(a,b,t): return a+(b-a)*t
def mix(a,b,t): return tuple(round(lerp(x,y,clamp(t))) for x,y in zip(a,b))
def entr(t,delay=0,dur=.75): return ease((t-delay)/dur)

@lru_cache(None)
def font(size,weight='Regular'):
    return ImageFont.truetype(str(FONT/f'OpenSans-{weight}.ttf'), round(size))

@lru_cache(maxsize=512)
def texttile(s,size,color=WHITE,weight='Regular'):
    f=font(size,weight); box=f.getbbox(s)
    im=Image.new('RGBA',(max(1,box[2]-box[0]+8),max(1,box[3]-box[1]+8)))
    ImageDraw.Draw(im).text((4-box[0],4-box[1]),s,font=f,fill=color)
    return im

def text(im,s,x,y,size=40,color=WHITE,weight='Regular',alpha=1,anchor='left'):
    if alpha<=0: return
    tile=texttile(s,size,color,weight)
    if anchor=='center': x-=tile.width/2
    elif anchor=='right': x-=tile.width
    if alpha<1:
        tile=tile.copy(); tile.putalpha(tile.getchannel('A').point(lambda a:round(a*alpha)))
    im.paste(tile,(round(x),round(y)),tile)

def rect(im,box,r=26,fill=None,outline=None,width=2):
    ImageDraw.Draw(im).rounded_rectangle(tuple(round(v) for v in box),radius=r,fill=fill,outline=outline,width=width)

def circle(im,x,y,r,fill,outline=None,width=2):
    ImageDraw.Draw(im).ellipse((round(x-r),round(y-r),round(x+r),round(y+r)),fill=fill,outline=outline,width=width)

def line(im,pts,color=LINE,width=3):
    ImageDraw.Draw(im).line([(round(x),round(y)) for x,y in pts],fill=color,width=width,joint='curve')

def progressline(im,a,b,p,color=BLUE,width=4):
    line(im,[a,b],LINE,width)
    line(im,[a,(lerp(a[0],b[0],p),lerp(a[1],b[1],p))],color,width)

def check(im,x,y,color=BLUE,scale=1):
    line(im,[(x-11*scale,y),(x-3*scale,y+8*scale),(x+15*scale,y-12*scale)],color,max(2,round(4*scale)))

def arrow(im,x,y,color=BLUE,size=13):
    line(im,[(x-size,y-size),(x,y),(x-size,y+size)],color,3)

@lru_cache(None)
def background(light=False):
    if light: return Image.new('RGB',(WIDTH,HEIGHT),PAPER)
    # Subtle original procedural vignette; computed once and cached.
    yy,xx=np.mgrid[0:HEIGHT,0:WIDTH]
    glow=np.exp(-((xx-1440)**2/(850**2)+(yy-400)**2/(600**2)))
    a=np.empty((HEIGHT,WIDTH,3),dtype=np.uint8)
    for k,c in enumerate(BG): a[:,:,k]=np.minimum(255,c+glow*[4,9,17][k]).astype(np.uint8)
    im=Image.fromarray(a)
    d=ImageDraw.Draw(im)
    for x in range(90,WIDTH,90):
        for y in range(90,HEIGHT,90): d.ellipse((x,y,x+1,y+1),fill=(29,37,51))
    return im

def header(im,section,number,light=False):
    ink=INK if light else WHITE
    text(im,'PHOTON',96,57,24,ink,'Semibold')
    text(im,'×',229,57,24,BLUE)
    text(im,'dot',265,51,32,ink,'Semibold')
    text(im,section.upper(),1820,59,22,(97,112,136) if light else MUTED,anchor='right')
    line(im,[(96,111),(1824,111)],(216,223,234) if light else LINE,1)
    text(im,f'{number:02d} / 08',96,995,20,(109,120,140) if light else MUTED)
    text(im,'THE iMESSAGE BRIDGE',1824,995,20,(109,120,140) if light else MUTED,anchor='right')

def title(im,s,x,y,t,delay=0,size=82,color=WHITE):
    p=entr(t,delay)
    text(im,s,x,y+38*(1-p),size,color,'Light',p)

def pill(im,s,x,y,w=None,light=False,blue=False):
    if w is None: w=texttile(s,26).width+36
    fill=(225,237,255) if light else (21,39,66)
    rect(im,(x,y,x+w,y+54),27,fill=fill if blue else ((233,236,242) if light else (24,32,47)))
    text(im,s,x+18,y+12,26,BLUE if blue else ((86,101,127) if light else MUTED))

def bubble(im,s,x,y,w,h=90,outgoing=True,small=False):
    fill=BLUE if outgoing else (40,49,66)
    rect(im,(x,y,x+w,y+h),min(34,h/3),fill=fill)
    # The small tail is original vector geometry, not an Apple asset.
    d=ImageDraw.Draw(im)
    if outgoing: d.polygon([(x+w-23,y+h-25),(x+w+5,y+h),(x+w-34,y+h-7)],fill=fill)
    else: d.polygon([(x+23,y+h-25),(x-5,y+h),(x+34,y+h-7)],fill=fill)
    text(im,s,x+25,y+(h-texttile(s,29 if small else 36).height)/2,29 if small else 36,WHITE)

def phone(im,x,y,t,scale=1,mode='intro'):
    # Draw in a fixed local canvas; scale only on composition.
    p=Image.new('RGBA',(440,820)); d=ImageDraw.Draw(p)
    rect(p,(10,0,430,810),66,fill=(9,12,18),outline=(79,95,121),width=3)
    rect(p,(22,12,418,798),56,fill=(18,23,32),outline=(34,43,60),width=2)
    rect(p,(150,30,290,65),19,fill=(3,5,10))
    circle(p,220,139,30,(29,59,101));text(p,'dot',220,121,26,WHITE,'Semibold',anchor='center')
    text(p,'dot',220,183,25,WHITE,anchor='center')
    line(p,[(23,232),(417,232)],(41,48,63),1)
    text(p,'iMessage',220,259,19,MUTED,anchor='center')
    p1=entr(t,.7,.65)
    if p1>0:
        layer=Image.new('RGBA',p.size)
        bubble(layer,'Can you help?',133,318+25*(1-p1),245,80,True,True)
        if p1<1: layer.putalpha(layer.getchannel('A').point(lambda a:round(a*p1)))
        p.alpha_composite(layer)
    if mode!='quiet':
        p2=entr(t,2.5,.7)
        if p2>0:
            layer=Image.new('RGBA',p.size)
            bubble(layer,'On it.',49,430+25*(1-p2),161,80,False,True)
            if p2<1: layer.putalpha(layer.getchannel('A').point(lambda a:round(a*p2)))
            p.alpha_composite(layer)
    rect(p,(49,698,390,756),29,outline=(66,76,94),width=2)
    text(p,'iMessage',73,714,22,(103,118,143))
    circle(p,359,728,18,BLUE);line(p,[(359,739),(359,718)],WHITE,3);line(p,[(351,726),(359,718),(367,726)],WHITE,3)
    rect(p,(158,778,282,785),3,fill=(205,214,229))
    if scale!=1: p=p.resize((round(p.width*scale),round(p.height*scale)),Image.Resampling.LANCZOS)
    im.paste(p,(round(x),round(y)),p)

def node(im,x,y,w,label,sub,kind='box',light=False,active=False):
    fill=(255,255,255) if light else (19,27,41)
    rect(im,(x,y,x+w,y+228),28,fill=fill,outline=BLUE if active else ((213,222,236) if light else LINE),width=2)
    if kind=='phone':
        rect(im,(x+30,y+31,x+66,y+90),8,outline=BLUE,width=3);line(im,[(x+42,y+81),(x+55,y+81)],BLUE,3)
    elif kind=='spectrum':
        for i in range(4): rect(im,(x+32+i*13,y+34+(3-i)*7,x+38+i*13,y+89),3,fill=BLUE)
    elif kind=='queue':
        for i in range(3): rect(im,(x+29,y+35+i*18,x+83,y+47+i*18),4,outline=BLUE,width=2)
    elif kind=='agent':
        circle(im,x+58,y+61,28,BLUE);circle(im,x+58,y+61,9,WHITE)
    text(im,label,x+29,y+112,39,INK if light else WHITE,'Semibold')
    text(im,sub,x+30,y+174,25,(104,118,141) if light else MUTED)

def caption(im,s,y=917,light=False):
    text(im,s,960,y,35,(86,101,126) if light else MUTED,anchor='center')

def scene0(t):
    im=background().copy();header(im,'The idea',1)
    title(im,'Your dot.',96,273,t+.9,.05,124)
    title(im,'In iMessage.',96,418,t+.2,.25,124,BLUE)
    p=entr(t,1.1)
    text(im,'A familiar conversation.',103,634,39,MUTED,alpha=p)
    text(im,'An active agent behind it.',103,694,39,MUTED,alpha=p)
    pill(im,'Connected through Photon',101,813,light=False,blue=True)
    y=178+40*(1-entr(t,.15,1))+math.sin(t*.75)*6
    phone(im,1284,y,t,.86)
    text(im,'ILLUSTRATIVE CONVERSATION',1475,925,18,MUTED,anchor='center')
    return im

def scene1(t):
    im=background(True).copy();header(im,'Existing foundation',2,True)
    title(im,'The bridge is already there.',96,189,t,size=85,color=INK)
    text(im,'Reuse the existing message runtime.',100,316,41,(96,110,133))
    xs=[122,703,1284];labels=[('iPhone','The conversation','phone'),('Photon','Spectrum connection','spectrum'),('Runtime','Existing Bun bridge','queue')]
    for i,(x,(a,b,k)) in enumerate(zip(xs,labels)):
        y=476+40*(1-entr(t,.25+i*.25))
        node(im,x,y,510,a,b,k,True,t>i*.7+.5)
    for i in range(2):
        a=(xs[i]+510,589);b=(xs[i+1],589)
        p=clamp((t-1-i*.7)/1.1)
        line(im,[a,b],(201,214,234),3);circle(im,lerp(a[0],b[0],p),589,7,BLUE)
    pill(im,'TLS / gRPC',824,764,w=275,light=True,blue=True)
    caption(im,'Keep the transport. Connect it to the active task.',light=True)
    return im

def scene2(t):
    im=background().copy();header(im,'Durable inbound work',3)
    title(im,'Save it before you process it.',96,190,t,size=83)
    text(im,'Messages become work the task can claim.',102,316,40,MUTED)
    # Distinct lanes convey batching instead of an unqualified delivery guarantee.
    for i in range(3):
        yy=458+i*105
        p=entr(t,.5+i*.65,1.2)
        xx=lerp(120,435,p)
        rect(im,(xx,yy,xx+320,yy+79),20,fill=(24,42,66),outline=(43,77,125))
        line(im,[(xx+30,yy+28),(xx+211,yy+28)],(120,160,218),4)
        line(im,[(xx+30,yy+49),(xx+151,yy+49)],(60,101,158),4)
    rect(im,(821,432,1188,798),31,fill=(16,27,45),outline=BLUE,width=3)
    text(im,'INBOX',1005,468,27,BLUE,'Semibold',anchor='center')
    for i in range(3):
        p=entr(t,1.35+i*.65,.7)
        if p>0:
            rect(im,(855,543+i*64,1154,588+i*64),10,fill=mix((16,27,45),(29,63,108),p))
            text(im,f'batch 0{i+1}',875,554+i*64,23,mix((16,27,45),(192,216,252),p))
    line(im,[(769,595),(809,595)],BLUE,3);arrow(im,809,595)
    for i,(a,b) in enumerate([('01','Persist'),('02','Batch'),('03','Claim')]):
        p=entr(t,.55+i*.75)
        text(im,a,1296,469+i*112,26,BLUE,alpha=p)
        text(im,b,1373,452+i*112,50,WHITE,'Light',p)
    caption(im,'A saved batch. A single owner. An expiring claim.')
    return im

def scene3(t):
    im=background().copy();header(im,'The reasoning boundary',4)
    title(im,'dot owns the response.',96,190,t,size=100)
    text(im,'The active task reads the batch and decides what to do.',103,329,39,MUTED)
    rect(im,(524,445,1396,767),38,fill=(19,31,51),outline=BLUE,width=2)
    # Ring is an abstract task marker, not an avatar or official logo.
    pulse=4*math.sin(t*1.7)
    circle(im,680,603,79+pulse,(26,59,105));circle(im,680,603,56,BLUE)
    text(im,'dot',680,573,54,WHITE,'Semibold',anchor='center')
    text(im,'ACTIVE TASK',810,499,27,BLUE,'Semibold')
    text(im,'Read. Then reason.',806,563,51,WHITE,'Light')
    text(im,'Authorize the reply',809,660,34,MUTED)
    for side in [0,1]:
        y=605;x0,x1=(165,508) if side==0 else (1413,1755)
        line(im,[(x0,y),(x1,y)],LINE,3)
        p=((t*.3)+side*.5)%1
        circle(im,lerp(x0,x1,p),y,8,BLUE)
    text(im,'SAVED BATCH',166,654,23,MUTED)
    text(im,'OUTBOX',1755,654,23,MUTED,anchor='right')
    pill(im,'No separate model in the listener',688,820,w=547,blue=True)
    caption(im,'An active task checks the inbox. No automatic platform wake.',y=919)
    return im

def scene4(t):
    im=background(True).copy();header(im,'The return path',5,True)
    title(im,'Back to the same conversation.',96,190,t,size=83,color=INK)
    text(im,'The reply goes through the existing outbound queue.',103,316,39,(96,110,133))
    xs=[124,704,1284]
    labels=[('Outbox','Authorized action','queue'),('Photon','Spectrum sends it','spectrum'),('iPhone','Original iMessage thread','phone')]
    for i,(x,(a,b,k)) in enumerate(zip(xs,labels)):
        node(im,x,456,510,a,b,k,True,clamp((t-.5)/2.5)>i/3)
    for i in range(2):
        x0,x1=xs[i]+510,xs[i+1]
        line(im,[(x0,568),(x1,568)],(201,214,234),3)
        p=clamp((t-.75-i*.8)/.9);circle(im,lerp(x0,x1,p),568,7,BLUE)
    names=['Queued','Provider accepted','Read receipt']
    for i,(x,s) in enumerate(zip([239,772,1355],names)):
        p=entr(t,2+i*.6)
        circle(im,x,792,12,mix((211,218,229),BLUE,p))
        text(im,s,x+28,770,32,INK)
    caption(im,'Delivery states stay distinct.',light=True)
    return im

def scene5(t):
    im=background().copy();header(im,'Voice input',6)
    title(im,'Voice becomes work for dot.',96,190,t,size=91)
    text(im,'The local Moonshine pipeline turns audio into text.',104,324,39,MUTED)
    rect(im,(117,457,765,729),32,fill=(17,29,47),outline=LINE,width=2)
    for i in range(49):
        xx=153+i*11.4
        h=18+89*abs(math.sin(i*.64+t*1.8))*math.sin(math.pi*(i+1)/50)
        color=BLUE if (i/49)<=clamp(t/4) else (44,64,94)
        rect(im,(xx,585-h/2,xx+5,585+h/2),2,fill=color)
    text(im,'VOICE NOTE',444,662,24,MUTED,anchor='center')
    line(im,[(786,592),(1026,592)],LINE,3)
    text(im,'Moonshine',906,531,30,BLUE,anchor='center')
    p=clamp((t-.9)/2);circle(im,lerp(788,1027,p),592,9,BLUE);arrow(im,1027,592)
    rect(im,(1054,457,1795,729),32,fill=(19,32,51),outline=BLUE,width=2)
    text(im,'TRANSCRIPT',1096,497,24,BLUE,'Semibold')
    for i,w in enumerate([579,490,547]):
        pp=entr(t,1.4+i*.55)
        if pp>0: rect(im,(1098,564+i*45,1098+w*pp,574+i*45),5,fill=(171,193,225))
    pill(im,'16 kHz · mono WAV',275,797,w=332,blue=True)
    pill(im,'Text joins the inbound batch',1190,797,w=470,blue=True)
    caption(im,'Local audio path verified. Phone-to-dot voice check still pending.')
    return im

def scene6(t):
    im=background().copy();header(im,'Evidence and boundaries',7)
    title(im,P['verification']['title'],96,190,t,size=84)
    for i,(label,value) in enumerate(P['verification']['rows']):
        pp=entr(t,.25+i*.32)
        yy=397+i*138+24*(1-pp)
        line(im,[(104,yy+109),(1817,yy+109)],LINE,1)
        circle(im,132,yy+42,20,(22,51,91))
        if i<2: check(im,131,yy+44,BLUE,.8)
        else:
            circle(im,132,yy+42,5,BLUE)
        text(im,label,188,yy+14,39,WHITE,'Semibold',pp)
        text(im,value,720,yy+16,36,MUTED,alpha=pp)
    caption(im,P['verification']['limitation'],y=921)
    return im

def scene7(t):
    im=background().copy();header(im,'The result',8)
    title(im,'iMessage is the interface.',96,275,t,.05,93)
    title(im,'dot stays the agent.',96,406,t,.45,108,BLUE)
    names=[('iPhone',180),('Photon',558),('Runtime',936),('dot',1314)]
    for i,(s,x) in enumerate(names):
        pp=entr(t,1+i*.15)
        rect(im,(x,652,x+320,764),28,fill=mix(BG,(19,34,57),pp),outline=mix(BG,LINE,pp))
        text(im,s,x+160,681,41,mix(BG,WHITE,pp),'Semibold',anchor='center')
        if i<3:
            line(im,[(x+320,707),(x+371,707)],BLUE,3);arrow(im,x+371,707)
    p=((t-2)*.16)%1
    if t>2:
        line(im,[(1490,786),(1490,827),(340,827),(340,786)],LINE,2)
        circle(im,lerp(1490,340,p),827,6,BLUE)
    caption(im,'Photon carries the messages. dot authors the response.',y=917)
    return im

SCENES=[scene0,scene1,scene2,scene3,scene4,scene5,scene6,scene7]
STARTS=[c['start'] for c in P['chapters']]

def render_frame(frame):
    t=max(0,min(frame/FPS,DURATION-1/FPS))
    idx=max(i for i,s in enumerate(STARTS) if s<=t)
    local=t-STARTS[idx]
    im=SCENES[idx](local)
    # Soft cross-dissolve always blends two designed frames, never black.
    if idx and local<.5:
        previous=SCENES[idx-1](STARTS[idx]-STARTS[idx-1]+local)
        im=Image.blend(previous,im,smooth(local/.5))
    # Continuous timeline is unobtrusive, and survives every transition.
    ImageDraw.Draw(im).rectangle((0,1075,round(WIDTH*t/DURATION),1079),fill=BLUE)
    return im.convert('RGB')
