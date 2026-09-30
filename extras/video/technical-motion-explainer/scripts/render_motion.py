#!/usr/bin/env python3
"""Render a deterministic Python frame module into H.264 MP4 or QA stills.

Module contract: WIDTH, HEIGHT, FPS, DURATION; render_frame(index) -> RGB image.
Dependencies: Pillow, FFmpeg, ffprobe. The supplied animation module may use
additional libraries. Only run source you authored or have permission to run.
"""
from __future__ import annotations
import argparse, importlib.util, json, math, os, subprocess, sys, tempfile
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


def load_module(path):
    spec=importlib.util.spec_from_file_location('motion_composition',path)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    for key in ['WIDTH','HEIGHT','FPS','DURATION','render_frame']:
        if not hasattr(module,key): raise ValueError(f'Missing module field: {key}')
    if module.WIDTH%2 or module.HEIGHT%2 or min(module.WIDTH,module.HEIGHT)<2:
        raise ValueError('H.264 output dimensions must be positive even integers')
    if not 0<module.FPS<=120 or module.DURATION<=0:
        raise ValueError('FPS must be in (0,120] and duration must be positive')
    return module


def checked_frame(m,index):
    im=m.render_frame(index)
    if not isinstance(im,Image.Image) or im.size!=(m.WIDTH,m.HEIGHT):
        raise ValueError(f'Frame {index} did not match {m.WIDTH}x{m.HEIGHT}')
    return im.convert('RGB')


def stills(m,dest,times):
    dest.mkdir(parents=True,exist_ok=True)
    items=[]
    for t in times:
        if not 0<=t<m.DURATION: raise ValueError(f'Still time out of range: {t}')
        f=min(round(t*m.FPS),round(m.DURATION*m.FPS)-1);im=checked_frame(m,f)
        path=dest/f'frame-{f:05d}-{t:06.2f}s.png';im.save(path)
        items.append((t,im))
    cols=2;w=960;h=round(w*m.HEIGHT/m.WIDTH);rows=math.ceil(len(items)/cols)
    sheet=Image.new('RGB',(cols*w,rows*(h+42)),(16,21,29));d=ImageDraw.Draw(sheet)
    for i,(t,im) in enumerate(items):
        x=(i%cols)*w;y=(i//cols)*(h+42)
        sheet.paste(im.resize((w,h),Image.Resampling.LANCZOS),(x,y))
        d.text((x+16,y+h+10),f'{t:05.2f}s  |  frame {round(t*m.FPS)}',fill='white')
    sheet.save(dest/'contact-sheet.jpg',quality=92)
    print(json.dumps({'stills':len(items),'contact_sheet':str(dest/'contact-sheet.jpg')}))


def probe(path):
    p=subprocess.run(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(path)],capture_output=True,text=True,check=True)
    return json.loads(p.stdout)


def render(m,output,fps,crf,preset,overwrite,start,end):
    if output.exists() and not overwrite: raise FileExistsError(f'{output} exists; use --overwrite explicitly')
    output.parent.mkdir(parents=True,exist_ok=True)
    count=round((end-start)*fps)
    if count<=0: raise ValueError('Range does not contain any frames')
    fd,temp=tempfile.mkstemp(suffix='.mp4',prefix='.render-',dir=output.parent);os.close(fd)
    tmp=Path(temp);log=output.with_suffix('.render.log')
    args=['ffmpeg','-y','-hide_banner','-loglevel','warning','-f','rawvideo','-pixel_format','rgb24',
          '-video_size',f'{m.WIDTH}x{m.HEIGHT}','-framerate',str(fps),'-i','pipe:0','-an',
          '-c:v','libx264','-crf',str(crf),'-preset',preset,'-pix_fmt','yuv420p',
          '-movflags','+faststart','-threads','4','-frames:v',str(count),str(tmp)]
    proc=None
    try:
        with log.open('w') as err:
            proc=subprocess.Popen(args,stdin=subprocess.PIPE,stderr=err)
            for i in range(count):
                frame=round((start+i/fps)*m.FPS)
                proc.stdin.write(checked_frame(m,frame).tobytes())
                if i%int(fps*5)==0: print(f'Rendered {i}/{count} frames',flush=True)
            proc.stdin.close();code=proc.wait()
        if code: raise RuntimeError(f'FFmpeg failed ({code}); see {log}')
        metadata=probe(tmp);stream=next(s for s in metadata['streams'] if s['codec_type']=='video')
        if int(stream['nb_frames'])!=count: raise RuntimeError('Encoded frame count differs from expected')
        if (stream['width'],stream['height'])!=(m.WIDTH,m.HEIGHT): raise RuntimeError('Encoded dimensions changed')
        if abs(float(metadata['format']['duration'])-count/fps)>.05: raise RuntimeError('Encoded duration differs from expected')
        os.replace(tmp,output)
        metadata['format']['filename']=str(output)
        report={'file':str(output),'expected_frames':count,'expected_duration':count/fps,'metadata':metadata}
        output.with_suffix('.probe.json').write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps({'file':str(output),'frames':count,'duration':count/fps,'bytes':output.stat().st_size}),flush=True)
    except BaseException:
        if proc and proc.poll() is None:
            proc.terminate();proc.wait(timeout=10)
        if tmp.exists(): tmp.unlink()
        raise


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('module',type=Path)
    ap.add_argument('--output',type=Path)
    ap.add_argument('--stills',type=Path)
    ap.add_argument('--times',help='Comma-separated seconds; defaults to five evenly spaced frames')
    ap.add_argument('--fps',type=int)
    ap.add_argument('--crf',type=int,default=18)
    ap.add_argument('--preset',default='medium',choices=['ultrafast','superfast','veryfast','faster','fast','medium','slow'])
    ap.add_argument('--start',type=float,default=0)
    ap.add_argument('--end',type=float)
    ap.add_argument('--overwrite',action='store_true')
    args=ap.parse_args()
    m=load_module(args.module.resolve())
    if args.stills:
        times=[float(x) for x in args.times.split(',')] if args.times else [i*(m.DURATION-1/m.FPS)/4 for i in range(5)]
        stills(m,args.stills,times)
    if args.output:
        fps=args.fps if args.fps is not None else m.FPS;end=args.end if args.end is not None else m.DURATION
        if not 0<=args.start<end<=m.DURATION: ap.error('Range must be inside the composition')
        if not 0<fps<=120: ap.error('FPS must be in (0,120]')
        render(m,args.output,fps,args.crf,args.preset,args.overwrite,args.start,end)
    if not args.output and not args.stills: ap.error('Choose --output and/or --stills')

if __name__=='__main__': main()
