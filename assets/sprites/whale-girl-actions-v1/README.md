# 四组动作素材

pat、celebrate、concern、idle-look各8帧；WebP播放时长约940/970/990/1455ms。运行时使用静态PNG处理减少动态效果。

AI参考生成图集位于source/，逐帧图像位于frames/，提示词位于prompts-v2.json，编码参数位于animation.json。build.cjs依赖sharp进行切帧、对齐、编码；它不是应用运行时依赖。素材权利说明见../../NOTICE及仓库根NOTICE。

这是整图关键帧动画，不是Live2D或已完成的分层rig。
